import { basename, join, resolve } from "node:path";
import { DateTime, Effect, Option, Ref, Result, Schema } from "effect";
import { InstalledSkills } from "./installed-skills.js";
import * as InstalledSkillStatus from "./installed-skill-status.js";
import { LibraryStore, withLibraryWriter } from "./store/library-store.js";
import { libraryStateRevision, type LibraryState, type InstalledSkill } from "./library-state.js";
import type { Request } from "./enabled-plan.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import { makeInstalledSkillId, type InstalledSkillId, type SkillId } from "./entity-ids.js";
import { installedSkillVariantPath } from "../install/files.js";
import type { OwnershipMarker } from "../contracts.js";
import { InstallScope } from "../vocabulary.js";
import { UninstallConflict, LibraryChanged } from "../failures.js";
import {
  DestinationsIncomplete,
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  Plan,
  Route,
  StalePlan,
  type AppliedChange,
  type EnabledChange,
  type InstalledSkillChange,
  type InstalledSkillResult,
  type Outcome,
} from "./library-plan.js";
import { planChanges } from "./plan-changes.js";

/** Policy: refuse a duplicate the request did not allow, or a link SKIT's copy would replace. */
const refuseDuplicates = Effect.fn("Library.refuseDuplicates")(function* (
  request: Request,
  change: EnabledChange,
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

/**
 * Carry out one change at a folder the next Library installs into, and what the Library records
 * for it. `next` is the Library just planned; `folders` are the folders that plan was decided on.
 */
const install = Effect.fn("Library.install")(function* (
  change: Exclude<
    Extract<InstalledSkillChange, { readonly skillVersionId: unknown }>,
    { readonly _tag: "Protected" }
  >,
  next: LibraryState,
  folders: readonly InstalledSkills.Folder[],
  /** The record already saved for a folder this change manages in place. */
  adopted?: InstalledSkill,
) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const installedAt = DateTime.formatIso(yield* DateTime.now);
  if (change._tag === "KeepDeleted") {
    const copy =
      change.recorded.status === "suppressed"
        ? change.recorded
        : InstalledSkillStatus.suppressed(change.recorded, installedAt);
    return { _tag: "Suppressed", copy } satisfies InstalledSkillResult;
  }
  if (change._tag === "Unreadable")
    return yield* new InstalledSkillInvalid({ detail: change.reason });
  const installedSkillId =
    adopted?.installed_skill_id ?? change.recorded?.installed_skill_id ?? makeInstalledSkillId();
  const pending = (expected_hash: InstalledSkill["expected_hash"]): InstalledSkill => ({
    installed_skill_id: installedSkillId,
    skill_id: change.skillId,
    skill_version_id: change.skillVersionId,
    destination: change.destination,
    root: change.root,
    path: change.path,
    expected_hash,
    status: "pending",
    installed_at: installedAt,
  });
  switch (change._tag) {
    case "Unchanged": {
      const copy = InstalledSkillStatus.installed(pending(change.hash));
      return { _tag: "Unchanged", copy } satisfies InstalledSkillResult;
    }
    case "Conflict": {
      if (change.edited)
        yield* files.backUp(
          change.path,
          installedSkillVariantPath(
            store.variantsPath,
            change.destination,
            basename(change.path),
            change.currentHash,
          ),
        );
      const copy = InstalledSkillStatus.conflicted(
        pending(change.hash),
        change.currentHash,
        change.expectedHash,
      );
      return { _tag: "Conflicted", copy } satisfies InstalledSkillResult;
    }
    case "Manage":
    case "Update":
    case "Install": {
      // A folder that was not there is built only now, once its root exists; apply created the
      // root since plan read the folder, so nothing may have appeared there.
      const staged = yield* files.build(change, next, store.originalsPath);
      const [folder] =
        change._tag === "Install"
          ? [yield* files.inspect(change.path)]
          : folders.filter((item) => item.path === resolve(change.path));
      if (
        folder === undefined ||
        (change._tag === "Install" ? folder.entry._tag !== "Absent" : staged.hash !== change.hash)
      )
        return yield* new StalePlan({
          message: `Installed skill evidence changed at ${change.path}`,
        });
      const marker: OwnershipMarker = {
        schemaVersion: 5,
        installed_skill_id: installedSkillId,
        skill_id: change.skillId,
        skill_version_id: change.skillVersionId,
        expected_hash: staged.hash,
      };
      const installed = yield* change._tag === "Manage"
        ? files.manage(staged, marker, folder, change.verification)
        : files.install(staged, marker, folder);
      const copy = InstalledSkillStatus.installed(pending(staged.hash), installed.hash);
      return { _tag: "Installed", copy } satisfies InstalledSkillResult;
    }
  }
});

/** The public result of one enabled change, derived only from what the Library recorded. */
const finish = (
  change: EnabledChange,
  skillIds: readonly SkillId[],
  targets: readonly InstalledSkills.Destination[],
  copies: readonly InstalledSkillResult[],
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
 * anything that differs from what was reviewed, then install, uninstall and record each Installed
 * Skill.
 */
export const apply = Effect.fn("Library.apply")(function* (reviewed: Plan) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  // A plan is never a source of write coordinates or Library rows.
  const input = structuredClone(reviewed);
  const stale = (message: string) => new StalePlan({ message });
  const changedSincePreview = () =>
    input.intent._tag === "Enabled"
      ? stale("Library changed after this change was previewed")
      : new LibraryChanged({ path: store.statePath });
  return yield* withLibraryWriter(
    Effect.scoped(
      Effect.gen(function* () {
        const base = yield* store.load;
        if (libraryStateRevision(base) !== input.baseRevision) return yield* changedSincePreview();
        const again = yield* planChanges(base, input.intent, input.approvals);
        const targetsAt = (scope: InstallScope) =>
          again.routes.find((route) => Schema.toEquivalence(InstallScope)(route.scope, scope))
            ?.destinations ?? [];
        // A refusal by policy says more than "changed since preview", so it is checked first.
        for (const change of again.changes)
          if (change._tag === "Refuse")
            return yield* new UninstallConflict({ detail: change.detail });
        for (const { request, change } of again.enabled)
          yield* refuseDuplicates(request, change, targetsAt(request.scope));
        if (
          !Schema.toEquivalence(Schema.Array(Route))(again.routes, input.routes) ||
          !Schema.toEquivalence(Plan.fields.changes)(
            [...again.enabled.map(({ change }) => change), ...again.changes],
            input.changes,
          )
        )
          return yield* stale("Installed agent targets or paths changed after preview");
        yield* files
          .check(input.folders)
          .pipe(
            Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
              Effect.fail(stale(error.message)),
            ),
          );

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
            : yield* Effect.as(store.save(again.next, base), again.next);

        // A folder taken over in place is recorded, as pending, before SKIT's marker is written
        // into it. A crash between the two leaves a recorded copy whose folder holds exactly
        // SKIT's bytes and no marker yet; the next change that plans it writes the marker.
        const adoptedAt = DateTime.formatIso(yield* DateTime.now);
        const adopted = new Map<string, InstalledSkill>();
        for (const change of again.changes)
          if (change._tag === "Manage" && change.verification === "manage")
            adopted.set(change.path, {
              installed_skill_id: change.recorded?.installed_skill_id ?? makeInstalledSkillId(),
              skill_id: change.skillId,
              skill_version_id: change.skillVersionId,
              destination: change.destination,
              root: change.root,
              path: change.path,
              expected_hash: change.hash,
              status: "pending",
              installed_at: adoptedAt,
            });
        const pendingRecords = new Map(
          [...adopted.values()].map((copy) => [copy.installed_skill_id, copy] as const),
        );
        const edited =
          adopted.size === 0
            ? intentSaved
            : yield* Effect.as(
                store.save(withRecords(intentSaved, pendingRecords), intentSaved),
                withRecords(intentSaved, pendingRecords),
              );

        // What changed for each record once everything succeeds (null once it is gone), and
        // what a failure records instead: only what is really on disk.
        const records = yield* Ref.make(new Map<InstalledSkillId, InstalledSkill | null>());
        const onDisk = yield* Ref.make(new Map<InstalledSkillId, InstalledSkill>());
        const copies = yield* Ref.make<readonly InstalledSkillResult[]>([]);
        const record = (
          copy: InstalledSkill,
          changes: {
            readonly final: InstalledSkill | null;
            readonly onDisk?: InstalledSkill;
            readonly result?: InstalledSkillResult;
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
                adopted.get(change.path),
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
            results: again.enabled.map(({ request, change, skillIds }) =>
              finish(change, skillIds, targetsAt(request.scope), [], saved),
            ),
            reason: "update",
            cause: ran.failure,
          } satisfies Outcome;
        }

        // Pending backups of every Installed Skill this apply touched are kept, or discarded when
        // the Library proves them reproducible. The save proves the Library is still `edited`.
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
        // Folders are written but could not be recorded: what was saved stands, unrecorded.
        if (Result.isFailure(recorded)) {
          if (input.intent._tag !== "Enabled") return yield* Effect.fail(recorded.failure);
          const touched = yield* Ref.get(copies);
          return {
            _tag: "Incomplete",
            results: again.enabled.map(({ request, change, skillIds }) =>
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
        const results = again.enabled.map(({ request, change, skillIds }) =>
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
