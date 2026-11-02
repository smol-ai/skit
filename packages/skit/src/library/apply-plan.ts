import { join } from "node:path";
import { DateTime, Effect, Option, Ref, Result, Schema } from "effect";
import { InstalledSkills } from "./installed-skills.js";
import * as InstalledSkillStatus from "./installed-skill-status.js";
import { LibraryStore, withLibraryWriter } from "./store/library-store.js";
import { libraryStateRevision, type LibraryState, type InstalledSkill } from "./library-state.js";
import type { Request } from "./enabled-plan.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import type { InstalledSkillId, SkillId } from "./entity-ids.js";
import { installedSkillVariantPath } from "../install/files.js";
import type { OwnershipMarker } from "../contracts.js";
import { InstallScope, type Hash } from "../vocabulary.js";
import { UninstallConflict, LibraryChanged } from "../failures.js";
import {
  Change,
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  Route,
  StalePlan,
  type AppliedChange,
  type BindingChange,
  type CopyResult,
  type Outcome,
  type Plan,
} from "./library-plan.js";
import { work } from "./plan-changes.js";
import type { Step, Wanted } from "./plan-steps.js";

const markerFor = (copy: InstalledSkills.Copy, hash: Hash): OwnershipMarker => ({
  schemaVersion: 5,
  installed_skill_id: copy.installedSkillId,
  skill_id: copy.skillId,
  skill_version_id: copy.skillVersionId,
  expected_hash: hash,
});

/** Policy: refuse a duplicate the request did not allow, or a link SKIT's copy would replace. */
const refuseDuplicates = Effect.fn("Library.refuseDuplicates")(function* (
  request: Request,
  change: BindingChange,
  targets: readonly InstalledSkills.Destination[],
) {
  if (!request.enabled || change.duplicates === undefined) return;
  if (!request.allowDuplicate) {
    const files = yield* InstalledSkills.Service;
    // Setup consent covers only these exact links, while they are still the links reviewed.
    const remaining: InstalledSkills.Duplicate[] = [];
    for (const duplicate of change.duplicates) {
      const aliases = [];
      for (const alias of duplicate.aliases) {
        const reviewed = request.setup?.approvedSymlinks.find(
          (item) => item.path === alias.path && item.canonicalPath === duplicate.canonicalPath,
        );
        if (reviewed !== undefined) {
          const entry = (yield* files.inspect(alias.path)).entry;
          if (
            entry._tag === "Present" &&
            entry.kind === "SymbolicLink" &&
            entry.identity.dev === reviewed.dev &&
            entry.identity.ino === reviewed.ino &&
            entry.linkTarget === reviewed.linkTarget
          )
            continue;
        }
        aliases.push(alias);
      }
      if (aliases.length) remaining.push({ ...duplicate, aliases });
    }
    if (remaining.length) return yield* new InstalledSkillWouldDuplicate({ duplicates: remaining });
    return;
  }
  const paths = targets.flatMap((target) => change.skills.map((name) => join(target.root, name)));
  const links = change.duplicates.flatMap((copy) =>
    copy.aliases
      .filter(
        (alias) =>
          alias.via === "symlink" && alias.linkPath === alias.path && paths.includes(alias.path),
      )
      .map((alias) => alias.path),
  );
  if (links.length) return yield* new InstalledSkillWouldReplaceLink({ links });
});

/** Carry out one step at a wanted copy's folder: the record it leaves, and what happened. */
const install = Effect.fn("Library.install")(function* (
  step: Exclude<Extract<Step, { readonly wanted: Wanted }>, { readonly _tag: "Protected" }>,
) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const { wanted } = step;
  const installedAt = DateTime.formatIso(yield* DateTime.now);
  if (step._tag === "KeepDeleted")
    return { copy: step.prior, result: { _tag: "Suppressed", copy: step.prior } } satisfies Done;
  if (step._tag === "Unreadable") return yield* new InstalledSkillInvalid({ detail: step.reason });
  // A folder that was not there is built only now, once its root exists.
  const staged =
    step._tag === "Install" ? yield* files.build(wanted.copy, wanted.destination) : step.staged;
  const row: InstalledSkill = {
    installed_skill_id: wanted.copy.installedSkillId,
    skill_id: wanted.copy.skillId,
    skill_version_id: wanted.copy.skillVersionId,
    destination: wanted.destination.destination,
    root: wanted.destination.root,
    path: wanted.path,
    expected_hash: staged.hash,
    status: "pending",
    installed_at: installedAt,
  };
  switch (step._tag) {
    case "Unchanged": {
      const copy = InstalledSkillStatus.installed(row);
      return { copy, result: { _tag: "Unchanged", copy } } satisfies Done;
    }
    case "Conflict": {
      const { hash, edited } = step;
      if (edited)
        yield* files.backUp(
          wanted.path,
          installedSkillVariantPath(
            store.variantsPath,
            wanted.destination.destination,
            wanted.name,
            hash,
          ),
        );
      const copy = InstalledSkillStatus.conflicted(row, hash, step.expectedHash);
      return { copy, result: { _tag: "Conflicted", copy } } satisfies Done;
    }
    case "Manage":
    case "Update":
    case "Install": {
      // Apply created the root since plan read this folder; nothing may have appeared there.
      const folder = step._tag === "Install" ? yield* files.inspect(wanted.path) : wanted.folder;
      if (folder.entry._tag !== "Absent" && step._tag === "Install")
        return yield* new StalePlan({
          message: `Installed skill evidence changed at ${wanted.path}`,
        });
      const marker = markerFor(wanted.copy, staged.hash);
      const installed = yield* step._tag === "Manage"
        ? files.manage(staged, marker, folder, step.verification)
        : files.install(staged, marker, folder);
      const copy = InstalledSkillStatus.installed(row, installed.hash);
      return { copy, result: { _tag: "Installed", copy } } satisfies Done;
    }
  }
});
/** The record one step leaves, and what happened to its copy. */
interface Done {
  readonly copy: InstalledSkill;
  readonly result: CopyResult;
}

/** The public result of one enabled change, derived only from what the Library recorded. */
const finish = (
  change: BindingChange,
  skillIds: readonly SkillId[],
  targets: readonly InstalledSkills.Destination[],
  copies: readonly CopyResult[],
  state: LibraryState,
): AppliedChange => {
  const installedSkills = state.installed_skills.filter(
    (copy) =>
      skillIds.includes(copy.skill_id) &&
      targets.some(
        (target) => copy.destination === target.destination && copy.root === target.root,
      ),
  );
  const paths =
    change._tag === "Enable"
      ? targets.flatMap((target) =>
          change.skills.map((name) => ({
            destination: target.destination,
            path: join(target.root, name),
          })),
        )
      : [];
  const unresolved = [
    ...new Set([
      ...paths
        .filter(
          (path) =>
            !installedSkills.some(
              (copy) =>
                copy.path === path.path &&
                copy.destination === path.destination &&
                copy.status === "installed",
            ),
        )
        .map((path) => path.path),
      ...installedSkills
        .filter(
          (copy) =>
            change._tag !== "Enable" ||
            copy.status !== "installed" ||
            !paths.some((path) => path.path === copy.path && path.destination === copy.destination),
        )
        .map((copy) => copy.path),
    ]),
  ];
  return {
    change,
    intent: change.changed ? "saved" : "unchanged",
    revision: libraryStateRevision(state),
    installedSkills,
    copies: copies.filter(
      (copy) => copy._tag !== "Failed" && skillIds.includes(copy.copy.skill_id),
    ),
    unresolved,
  };
};

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

/**
 * Carry out a reviewed plan under the Library writer: plan again from the loaded Library, refuse
 * anything that differs from what was reviewed, then install, uninstall and record each copy.
 */
export const apply = Effect.fn("Library.apply")(function* (reviewed: Plan) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  // A plan is never a source of write coordinates or Library rows.
  const input = structuredClone(reviewed);
  const stale = (message: string) => new StalePlan({ message });
  const changedSincePreview = () =>
    input.intent._tag === "Enabled"
      ? stale("Library changed after this Binding change was previewed")
      : new LibraryChanged({ path: store.statePath });
  return yield* withLibraryWriter(
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* store.load;
        if (libraryStateRevision(base) !== input.baseRevision) return yield* changedSincePreview();
        const again = yield* work(base, input.intent, input.approvals);
        const targetsAt = (scope: InstallScope) =>
          again.routes.find((route) => Schema.toEquivalence(InstallScope)(route.scope, scope))
            ?.destinations ?? [];
        // A refusal by policy says more than "changed since preview", so it is checked first.
        for (const step of again.steps)
          if (step.change._tag === "Refuse")
            return yield* new UninstallConflict({ detail: step.change.detail });
        for (const { request, change } of again.requests)
          yield* refuseDuplicates(request, change, targetsAt(request.scope));
        if (
          !Schema.toEquivalence(Schema.Array(Route))(again.routes, input.routes) ||
          !Schema.toEquivalence(Schema.Array(Change))(again.changes, input.changes)
        )
          return yield* stale("Installed agent targets or paths changed after preview");
        yield* files
          .check(input.folders)
          .pipe(
            Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
              Effect.fail(stale(error.message)),
            ),
          );

        // Folders exist and are writable before the Library saves what it wants.
        yield* files.prepare([
          ...new Set(
            again.steps.flatMap((step) =>
              "wanted" in step && step._tag !== "KeepDeleted" && step._tag !== "Protected"
                ? [step.wanted.destination.root]
                : [],
            ),
          ),
        ]);
        // What is enabled is saved first. A removed Collection is saved only with its copies'
        // uninstalls, since records may not name what the Library no longer has.
        const edited =
          input.intent._tag === "Remove" ||
          libraryStateRevision(again.next) === libraryStateRevision(base)
            ? base
            : yield* Effect.as(store.save(again.next, base), again.next);

        // What changed for each record once everything succeeds (null once it is gone), and
        // what a failure records instead: only what is really on disk.
        const records = yield* Ref.make(new Map<InstalledSkillId, InstalledSkill | null>());
        const onDisk = yield* Ref.make(new Map<InstalledSkillId, InstalledSkill>());
        const copies = yield* Ref.make<readonly CopyResult[]>([]);
        const record = (
          copy: InstalledSkill,
          changes: {
            readonly final: InstalledSkill | null;
            readonly onDisk?: InstalledSkill;
            readonly result?: CopyResult;
          },
        ) => {
          const { final, onDisk: written, result } = changes;
          return Effect.all([
            Ref.update(records, (all) => new Map(all).set(copy.installed_skill_id, final)),
            written === undefined
              ? Effect.void
              : Ref.update(onDisk, (all) => new Map(all).set(copy.installed_skill_id, written)),
            result === undefined ? Effect.void : Ref.update(copies, (all) => [...all, result]),
          ]);
        };
        const kept = (copy: InstalledSkill) =>
          input.intent._tag === "Uninstall" && !input.intent.drop.includes(copy.installed_skill_id)
            ? copy.status === "suppressed"
              ? copy
              : InstalledSkillStatus.pending(copy)
            : null;

        // Install first; a Skill's old copy is uninstalled only after its new one is installed.
        const run = Effect.gen(function* () {
          const installedAt = new Set<string>();
          for (const step of again.steps) {
            if (!("wanted" in step) || step._tag === "Protected") continue;
            const { wanted } = step;
            const done = yield* install(step).pipe(
              Effect.tapError(() =>
                Effect.gen(function* () {
                  // An unverified successor stands where the original was: never call it pending.
                  if (wanted.prior === undefined) return;
                  const now = yield* files.inspect(wanted.path).pipe(Effect.option);
                  if (Option.isSome(now) && now.value.entry._tag === "Absent") {
                    const pending = InstalledSkillStatus.pending(wanted.prior);
                    yield* record(wanted.prior, { final: pending, onDisk: pending });
                  }
                }),
              ),
            );
            yield* record(done.copy, {
              final: done.copy,
              ...(done.result._tag === "Installed" ? { onDisk: done.copy } : {}),
              result: done.result,
            });
            if (done.copy.status === "installed")
              installedAt.add(`${done.copy.skill_id}\0${done.copy.destination}`);
          }
          for (const step of again.steps) {
            if ("wanted" in step || step._tag === "Protected") continue;
            const { copy } = step;
            // Keep the last working copy where its successor is blocked, protected or locally
            // modified: only a copy apply installed is a successor.
            const succeeded = again.steps.some(
              (other) =>
                "wanted" in other &&
                other.wanted.copy.skillId === copy.skill_id &&
                other.wanted.destination.destination === copy.destination,
            );
            if (succeeded && !installedAt.has(`${copy.skill_id}\0${copy.destination}`)) continue;
            switch (step._tag) {
              case "Forget":
                yield* record(copy, { final: kept(copy) });
                break;
              case "Keep": {
                const conflicted = InstalledSkillStatus.conflicted(copy, step.hash);
                yield* record(copy, {
                  final: conflicted,
                  result: { _tag: "Conflicted", copy: conflicted },
                });
                break;
              }
              case "Uninstall":
                yield* files.uninstall(copy.root, copy.path, copy.installed_skill_id);
                // Moved to recovery: until the Library records why, it is pending, never deleted.
                yield* record(copy, {
                  final: kept(copy),
                  onDisk: copy.status === "suppressed" ? copy : InstalledSkillStatus.pending(copy),
                  result: { _tag: "Uninstalled", copy },
                });
                break;
            }
          }
        });

        const ran = yield* Effect.result(run);
        if (Result.isFailure(ran)) {
          // A failure saves only what is really on disk, onto what was already saved.
          const written = yield* Ref.get(onDisk);
          const saved =
            written.size === 0
              ? edited
              : yield* Effect.as(
                  store.save(withRecords(edited, written), edited),
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
            results: again.requests.map(({ request, change, skillIds }) =>
              finish(change, skillIds, targetsAt(request.scope), [], saved),
            ),
            reason: "update",
            cause: ran.failure,
          } satisfies Outcome;
        }

        // Pending backups of every copy this apply touched are kept, or discarded when the
        // Library proves them reproducible. The save proves the Library is still `edited`.
        const changed = yield* Ref.get(records);
        const pending = yield* Effect.forEach(
          [...edited.installed_skills, ...[...changed.values()].filter((copy) => copy !== null)]
            .filter((copy) => changed.has(copy.installed_skill_id))
            .filter(
              (copy, index, all) =>
                all.findIndex(
                  (other) =>
                    other.installed_skill_id === copy.installed_skill_id &&
                    other.root === copy.root,
                ) === index,
            ),
          (copy) =>
            Effect.map(files.backups.scan(copy.root, copy.installed_skill_id), (backups) =>
              backups.map((backup) => ({ backup, copy })),
            ),
        ).pipe(
          Effect.map((groups) => groups.flat()),
          Effect.catchCause((cause) =>
            Effect.as(Effect.logWarning("Installed-skill backups stayed pending", cause), []),
          ),
        );
        const final = withRecords(input.intent._tag === "Remove" ? again.next : edited, changed);
        const recorded = yield* Effect.result(
          pending.length > 0 || libraryStateRevision(final) !== libraryStateRevision(edited)
            ? Effect.as(store.save(final, edited), final)
            : Effect.succeed(edited),
        );
        // Copies are written but could not be recorded: what was saved stands, unrecorded.
        if (Result.isFailure(recorded)) {
          if (input.intent._tag !== "Enabled") return yield* Effect.fail(recorded.failure);
          const touched = yield* Ref.get(copies);
          return {
            _tag: "Incomplete",
            results: again.requests.map(({ request, change, skillIds }) =>
              finish(change, skillIds, targetsAt(request.scope), touched, edited),
            ),
            reason: "update",
            cause: recorded.failure,
          } satisfies Outcome;
        }
        const saved = recorded.success;
        for (const { backup, copy } of pending)
          yield* Effect.gen(function* () {
            const reproducible = yield* files.backups
              .check(backup, edited, store.originalsPath, copy.installed_skill_id)
              .pipe(Effect.orElseSucceed(() => false));
            yield* reproducible ? files.backups.discard(backup) : files.backups.keep(backup);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Library changed, but installed-skill backups stayed pending",
                cause,
              ),
            ),
          );

        const touched = yield* Ref.get(copies);
        const results = again.requests.map(({ request, change, skillIds }) =>
          finish(change, skillIds, targetsAt(request.scope), touched, saved),
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
    ),
  ).pipe(
    Effect.catchTag("LibraryChanged", (error) =>
      Effect.fail(input.intent._tag === "Enabled" ? changedSincePreview() : error),
    ),
  );
});
