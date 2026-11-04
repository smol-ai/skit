import { Effect, Option, Result, Schema } from "effect";
import { InstalledSkills } from "../../installed-skills.js";
import * as InstalledSkillStatus from "../../installed-skill-status.js";
import {
  LibraryWriter,
  libraryOriginalsPath,
  libraryVariantsPath,
} from "../../store/library-store.js";
import {
  libraryStateRevision,
  type LibraryState,
  type InstalledSkill,
} from "../../library-state.js";
import { type InstalledSkillId, type OperationId } from "../../entity-ids.js";
import { OperationStatus } from "../../store/state-schema.js";
import { InstallScope } from "../../../vocabulary.js";
import {
  DestinationsIncomplete,
  Plan,
  StalePlan,
  type InstalledSkillResult,
  type Outcome,
} from "../../library-plan.js";

import { reviewApply } from "./review.js";
import { finishChange } from "./result.js";
import { install } from "./installed-changes.js";
/** `onto` with these records changed; null removes a record. */
const withRecords = (
  onto: LibraryState,
  changed: ReadonlyMap<InstalledSkillId, InstalledSkill | null>,
): LibraryState => ({
  ...onto,
  installed_skills: [
    ...onto.installed_skills.flatMap((copy) => {
      const now = changed.get(copy.installed_skill_id);
      return now === undefined ? [copy] : now === null ? [] : [now];
    }),
    ...[...changed.values()].filter(
      (copy): copy is InstalledSkill =>
        copy !== null &&
        !onto.installed_skills.some((item) => item.installed_skill_id === copy.installed_skill_id),
    ),
  ],
});

/** Execute inside an existing recorded step, keeping the folder and publication policies here. */
export const apply = Effect.fn("Library.apply")(function* (
  reviewed: Plan,
  execution: {
    readonly operationId: OperationId;
    readonly step: number;
    readonly batch?: string;
    readonly expected: readonly InstalledSkill[];
  },
) {
  const writer = yield* LibraryWriter;
  const files = yield* InstalledSkills.Service;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { input, base, again } = yield* reviewApply(writer.home, reviewed);
      const targetsAt = (scope: InstallScope) =>
        again.routes.find((route) => Schema.toEquivalence(InstallScope)(route.scope, scope))
          ?.destinations ?? [];

      const expectedAt = (path: string) =>
        Effect.gen(function* () {
          const row = execution.expected.find((row) => row.path === path);
          if (!row)
            return yield* new StalePlan({ message: `Missing recorded installed row: ${path}` });
          return row;
        });
      // Folders exist and are writable before the Library saves what is enabled.
      yield* files.prepare([
        ...new Set(
          again.changes.flatMap((change) =>
            "skillVersionId" in change &&
            change._tag !== "KeepDeleted" &&
            change._tag !== "Protected"
              ? [change.root]
              : [],
          ),
        ),
      ]);
      // What is enabled is saved first. A removed Collection is saved only with its Installed
      // Skills' uninstalls, since records may not name what the Library no longer has.
      const intentSaved =
        input.intent._tag === "Remove" ||
        libraryStateRevision(again.next) === libraryStateRevision(base)
          ? base
          : yield* Effect.as(writer.save(again.next, base), again.next);

      // A folder taken over in place is recorded, as pending, before SKIT's marker is written
      // into it. A crash between the two leaves a recorded copy whose folder holds exactly
      // SKIT's bytes and no marker yet; the next change that plans it writes the marker.
      const adopted = new Map<string, InstalledSkill>();
      for (const change of again.changes)
        if (change._tag === "Manage" && change.verification === "manage")
          adopted.set(change.path, InstalledSkillStatus.pending(yield* expectedAt(change.path)));
      const pendingRecords = new Map(
        [...adopted.values()].map((copy) => [copy.installed_skill_id, copy] as const),
      );
      const edited =
        adopted.size === 0
          ? intentSaved
          : yield* Effect.as(
              writer.save(withRecords(intentSaved, pendingRecords), intentSaved),
              withRecords(intentSaved, pendingRecords),
            );

      // What changed for each record once everything succeeds (null once it is gone), and
      // what a failure records instead: only what is really on disk.
      const records = new Map<InstalledSkillId, InstalledSkill | null>();
      const onDisk = new Map<InstalledSkillId, InstalledSkill>();
      const copies: InstalledSkillResult[] = [];
      const record = (
        copy: InstalledSkill,
        changes: {
          readonly final: InstalledSkill | null;
          readonly onDisk?: InstalledSkill;
          readonly result?: InstalledSkillResult;
        },
      ) => {
        const { final, onDisk: written, result } = changes;
        return Effect.sync(() => {
          records.set(copy.installed_skill_id, final);
          if (written !== undefined) onDisk.set(copy.installed_skill_id, written);
          if (result !== undefined) copies.push(result);
        });
      };
      const kept = (copy: InstalledSkill) =>
        input.intent._tag === "Uninstall" && !input.intent.drop.includes(copy.installed_skill_id)
          ? copy.status === "suppressed"
            ? copy
            : InstalledSkillStatus.pending(copy)
          : null;

      // Install first; a Skill's old folder is uninstalled only after its new one is installed,
      // and plan lists every install before any uninstall.
      const run = Effect.gen(function* () {
        const installedAt = new Set<string>();
        for (const change of again.changes) {
          if (change._tag === "Protected" || change._tag === "Refuse") continue;
          if ("skillVersionId" in change) {
            const result = yield* install(
              change,
              again.next,
              again.folders,
              yield* expectedAt(change.path),
              libraryOriginalsPath(writer.home),
              libraryVariantsPath(writer.home),
            ).pipe(
              Effect.tapError(() =>
                Effect.gen(function* () {
                  // An unverified successor stands where the original was: never call it pending.
                  if (change.recorded === undefined) return;
                  const now = yield* files.inspect(change.path).pipe(Effect.option);
                  if (Option.isSome(now) && now.value.entry._tag === "Absent") {
                    const pending = InstalledSkillStatus.pending(change.recorded);
                    yield* record(change.recorded, { final: pending, onDisk: pending });
                  }
                }),
              ),
            );
            yield* record(result.copy, {
              final: result.copy,
              ...(result._tag === "Installed" ? { onDisk: result.copy } : {}),
              result,
            });
            if (result.copy.status === "installed")
              installedAt.add(`${result.copy.skill_id}\0${result.copy.destination}`);
            continue;
          }
          const { recorded } = change;
          // Keep the last working folder where its successor is blocked, protected or locally
          // modified: only a folder apply installed is a successor.
          const succeeded = again.changes.some(
            (other) =>
              "skillVersionId" in other &&
              other.skillId === recorded.skill_id &&
              other.destination === recorded.destination,
          );
          if (succeeded && !installedAt.has(`${recorded.skill_id}\0${recorded.destination}`))
            continue;
          switch (change._tag) {
            case "Forget":
              yield* record(recorded, { final: kept(recorded) });
              break;
            case "Conflict": {
              const conflicted = InstalledSkillStatus.conflicted(recorded, change.currentHash);
              yield* record(recorded, {
                final: conflicted,
                result: { _tag: "Conflicted", copy: conflicted },
              });
              break;
            }
            case "Uninstall":
              yield* files.uninstall(recorded.root, recorded.path, recorded.installed_skill_id);
              // Moved to recovery: until the Library records why, it is pending, never deleted.
              yield* record(recorded, {
                final: kept(recorded),
                onDisk:
                  recorded.status === "suppressed"
                    ? recorded
                    : InstalledSkillStatus.pending(recorded),
                result: { _tag: "Uninstalled", copy: recorded },
              });
              break;
          }
        }
      });

      const ran = yield* Effect.result(run);
      if (Result.isFailure(ran)) {
        // A failure saves only what is really on disk, onto what was already saved.
        const written = onDisk;
        const saved =
          written.size === 0
            ? edited
            : yield* Effect.as(
                writer.save(withRecords(edited, written), edited),
                withRecords(edited, written),
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.as(
                    Effect.logWarning(
                      "Installed skills changed, but the Library could not record them",
                      cause,
                    ),
                    edited,
                  ),
                ),
              );
        if (input.intent._tag !== "Enabled") return yield* Effect.fail(ran.failure);
        return {
          _tag: "Incomplete",
          results: again.enabled.map(({ request, change, skillIds }) =>
            finishChange(change, skillIds, targetsAt(request.scope), [], saved),
          ),
          reason: "update",
          cause: ran.failure,
        } satisfies Outcome;
      }

      const changed = records;
      let final = withRecords(input.intent._tag === "Remove" ? again.next : edited, changed);
      {
        const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
          final.operations,
        ).pipe(
          Effect.mapError(
            () => new StalePlan({ message: "The recorded apply operation is invalid" }),
          ),
        );
        const operation = operations.find((item) => item.operationId === execution.operationId);
        const outer = operation?.steps[execution.step];
        const saved =
          execution.batch === undefined
            ? outer?.step
            : outer?.applies?.find((item) => item.key === execution.batch)?.apply;
        if (operation?._tag !== "Pending" || saved?._tag !== "Apply")
          return yield* new StalePlan({
            message: "The recorded apply operation is no longer Pending",
          });
        const folders = yield* Effect.forEach(input.folders, (folder) =>
          files.inspect(folder.path),
        );
        const { operations: _history, ...publication } = final;
        const encoded = yield* Schema.encodeEffect(OperationStatus)({
          ...operation,
          steps: operation.steps.map((item, index) => {
            if (index !== execution.step) return item;
            const completed = Option.some({
              state: publication,
              folders: folders.map((folder) => ({
                path: folder.path,
                evidence: folder.evidence,
                ancestors: folder.ancestors,
                entry: folder.entry._tag === "Absent" ? ("Absent" as const) : folder.entry.kind,
              })),
            });
            return execution.batch === undefined
              ? { ...item, step: { ...saved, completed } }
              : {
                  ...item,
                  applies: item.applies?.map((batch) =>
                    batch.key === execution.batch
                      ? { ...batch, apply: { ...saved, completed } }
                      : batch,
                  ),
                };
          }),
        }).pipe(
          Effect.mapError(
            () => new StalePlan({ message: "The completed apply operation is invalid" }),
          ),
        );
        final = {
          ...final,
          operations: final.operations.map((item) =>
            item.operationId === execution.operationId ? encoded : item,
          ),
        };
      }
      const recorded = yield* Effect.result(Effect.as(writer.save(final, edited), final));
      // Folders are written but could not be recorded: what was saved stands, unrecorded.
      if (Result.isFailure(recorded)) {
        if (input.intent._tag !== "Enabled") return yield* Effect.fail(recorded.failure);
        const touched = copies;
        return {
          _tag: "Incomplete",
          results: again.enabled.map(({ request, change, skillIds }) =>
            finishChange(change, skillIds, targetsAt(request.scope), touched, edited),
          ),
          reason: "update",
          cause: recorded.failure,
        } satisfies Outcome;
      }
      const saved = recorded.success;
      yield* settleBackups(
        edited,
        [...edited.installed_skills, ...execution.expected].filter((row) =>
          changed.has(row.installed_skill_id),
        ),
      );

      const touched = copies;
      const results = again.enabled.map(({ request, change, skillIds }) =>
        finishChange(change, skillIds, targetsAt(request.scope), touched, saved),
      );
      const unresolved = results.flatMap((result) => result.unresolved);
      if (unresolved.length)
        return {
          _tag: "Incomplete",
          results,
          reason: "destinations",
          cause: new DestinationsIncomplete({ paths: unresolved }),
        } satisfies Outcome;
      return { _tag: "Applied", results, copies: touched } satisfies Outcome;
    }),
  ).pipe(
    Effect.catchTag("LibraryChanged", () =>
      Effect.fail(new StalePlan({ message: "Library changed after this change was previewed" })),
    ),
  );
});

/** Called only after committing state, including when startup verifies a completed apply. */
export const settleBackups = Effect.fn("Library.settleApplyBackups")(function* (
  prior: LibraryState,
  rows: readonly InstalledSkill[],
) {
  const { home } = yield* LibraryWriter;
  const files = yield* InstalledSkills.Service;
  const unique = rows.filter(
    (row, index) =>
      rows.findIndex(
        (other) => other.installed_skill_id === row.installed_skill_id && other.root === row.root,
      ) === index,
  );
  for (const copy of unique)
    yield* Effect.gen(function* () {
      for (const backup of yield* files.backups.scan(copy.root, copy.installed_skill_id)) {
        const reproducible = yield* files.backups
          .check(backup, prior, libraryOriginalsPath(home), copy.installed_skill_id)
          .pipe(Effect.orElseSucceed(() => false));
        yield* reproducible ? files.backups.discard(backup) : files.backups.keep(backup);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Library changed, but installed-skill backups stayed pending", cause),
      ),
    );
});
