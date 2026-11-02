import { join } from "node:path";
import { collectionVersionPath } from "./collection-version.js";
import { Clock, Context, Data, Effect, FileSystem, Layer, Option, Predicate, Result } from "effect";
import { InstalledSkills } from "./installed-skills.js";
import * as InstalledSkillStatus from "./installed-skill-status.js";
import {
  LibraryStore,
  withLibraryWriter,
  type LibraryStateReadError,
  type LibraryStateWriteError,
} from "./store/library-store.js";
import {
  libraryStateRevision,
  enabledAt,
  setEnabledAt,
  pruneEmptyEnabled,
  type LibraryState,
  type InstalledSkill,
} from "./library-state.js";
import {
  calculateEnabled,
  expandIntent,
  InvalidIntent,
  type Intent as EnabledIntent,
  type Request,
} from "./enabled-plan.js";
import {
  skillsToCheckForDuplicates,
  deviceInstallationIntent,
  removeFromEnabled,
  enabledByScope,
} from "./enabled.js";
import { currentSkillVersion, enabledSkillIds, versionBacking } from "./library-contracts.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import { leftoverSkills, repositorySelectsInstalledSkill } from "./installation/uninstall.js";
import { CollectionRemovalMissing } from "./installation/remove.js";
import {
  makeInstalledSkillId,
  type CollectionId,
  type InstalledSkillId,
  type SkillId,
} from "./entity-ids.js";
import {
  decide,
  installedSkillName,
  installedSkillVariantPath,
  type Decision,
  type ManageApproval,
} from "../install/files.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../install/policy.js";
import { pathIsWithin } from "../platform/path-identity.js";
import type { OwnershipMarker } from "../contracts.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { UninstallConflict, LibraryChanged } from "../failures.js";
import { importCollection, importAuthoredCollection, importEdit } from "./import-collection.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
export {
  InvalidIntent,
  calculateEnabled,
  enabledCollections,
  uniqueInstallScopes,
  sameInstallScope,
} from "./enabled-plan.js";
export type { Subject, Invocation, EnabledCollection, SetupApproval } from "./enabled-plan.js";
/** Remove a Collection with its Skills, imports, enabled entries and installed copies. */
export interface Remove {
  readonly _tag: "Remove";
  readonly collectionId: CollectionId;
}
/**
 * Bring installed copies up to date: of one Collection, at every scope enabling it; or, without a
 * Collection, every copy everywhere, uninstalling what nothing enables any more.
 */
export interface Update {
  readonly _tag: "Update";
  readonly collectionId?: CollectionId;
}
/** Uninstall these recorded copies. Their records stay, as pending, unless listed to drop. */
export interface Uninstall {
  readonly _tag: "Uninstall";
  readonly copies: readonly InstalledSkillId[];
  readonly drop: readonly InstalledSkillId[];
}
/**
 * Install the selected Skills' copies at one destination, as a setup or version choice reviewed
 * them. Its approvals are the only exceptions to the default safety rules it may use.
 */
export interface Install {
  readonly _tag: "Install";
  readonly scope: Request["scope"];
  readonly destination: InstalledSkills.Destination;
  /** Only these Skills; every Skill enabled at the scope when absent. */
  readonly only?: readonly SkillId[];
  /** Put back copies of these Skills that the user deleted. */
  readonly restoreDeleted: readonly SkillId[];
  /** Manage a folder that already holds exactly SKIT's bytes. */
  readonly manageIdentical: boolean;
  /** Folders the user approved managing, as previewed. */
  readonly manage?: ManageApproval;
  /** Edited copies the user accepted as the selected Version, as previewed. */
  readonly acceptedCopies?: readonly {
    readonly installedSkillId: InstalledSkillId;
    readonly currentHash: InstalledSkill["expected_hash"];
    readonly marker: OwnershipMarker;
  }[];
}
export type Intent = EnabledIntent | Remove | Update | Install | Uninstall;

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────
export class StalePlan
  extends Data.TaggedError("Library.SetEnabledStale")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the Binding change again.";
}
const stale = (message = "Library changed after this Binding change was previewed") =>
  new StalePlan({ message });

/** Enabling would replace the user's own link where SKIT writes the copy; keeping both is impossible. */
export class InstalledSkillWouldReplaceLink
  extends Data.TaggedError("InstalledSkillWouldReplaceLink")<{ links: readonly string[] }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Remove the link and enable again, or run `skit setup` and choose `--duplicates retire-aliases` to back it up with a move record.";
  get message() {
    return `Enabling would replace the link at ${this.links.join(", ")} with SKIT's copy, so both cannot be kept`;
  }
}

/** Policy: Library refuses a duplicate; InstalledSkills only reports that it is there. */
export class InstalledSkillWouldDuplicate
  extends Data.TaggedError("InstalledSkillWouldDuplicate")<{
    duplicates: readonly InstalledSkills.Duplicate[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Remove the redundant agent location, retain without enabling, or explicitly use --allow-duplicate.";
  get message() {
    return `Enabling would create duplicate skills: ${this.duplicates.flatMap((item) => item.aliases.map((alias) => `${item.name} (${item.harness}): ${alias.path}${alias.via === "symlink" ? ` -> ${item.canonicalPath} (symlink${alias.linkPath !== alias.path ? ` at ${alias.linkPath} -> ${alias.linkTarget}` : ""})` : ""}`)).join("; ")}`;
  }
}

export class DestinationsIncomplete
  extends Data.TaggedError("Library.SetEnabledDestinationsIncomplete")<{ paths: readonly string[] }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Inspect these destinations and preserve foreign or modified content before retrying.";
  get message() {
    return `Selected destinations have not converged: ${this.paths.join(", ")}`;
  }
}

// ── Plan and outcome ─────────────────────────────────────────────────────────────────────────────
type Calculated = Effect.Success<ReturnType<typeof calculateEnabled>>;
export type BindingChange = Calculated["plan"] & {
  readonly _tag: "Enable" | "Disable";
  readonly repair?: boolean;
  readonly duplicates?: readonly InstalledSkills.Duplicate[];
  readonly warnings?: readonly InstalledSkills.Warning[];
  readonly unmanaged_destinations?: readonly {
    readonly destination: "agents" | "claude";
    readonly path: string;
  }[];
};
export interface CopyChange {
  readonly _tag: "Install" | "Uninstall";
  readonly skillId: InstalledSkill["skill_id"];
  readonly destination: InstalledSkill["destination"];
  readonly path: string;
}
export interface RemoveChange {
  readonly _tag: "Remove";
  readonly collectionId: CollectionId;
  readonly skillIds: readonly SkillId[];
}
export type Change = BindingChange | CopyChange | RemoveChange;

/**
 * Plain data. Nothing in it is trusted at apply: apply reloads the Library and refuses a different
 * revision, recomputes every change from the intents, and re-observes every path.
 */
export interface Plan {
  readonly baseRevision: string;
  readonly intents: readonly Intent[];
  readonly routes: readonly {
    readonly scope: Request["scope"];
    readonly destinations: readonly InstalledSkills.Destination[];
  }[];
  readonly observed: readonly InstalledSkills.Observed[];
  readonly changes: readonly Change[];
}

/** The final state of one copy SKIT touched, as the Library recorded it. */
export type CopyResult =
  | {
      readonly _tag: "Installed" | "Unchanged" | "Conflicted" | "Suppressed";
      readonly copy: InstalledSkill;
    }
  | { readonly _tag: "Uninstalled"; readonly copy: InstalledSkill }
  /** Moved to recovery with no verified successor; recorded as pending. */
  | { readonly _tag: "Pending"; readonly copy: InstalledSkill }
  | { readonly _tag: "Failed"; readonly path: string; readonly cause: ApplyError };

export interface AppliedChange {
  readonly change: BindingChange;
  readonly intent: "saved" | "unchanged";
  readonly revision: string;
  readonly installedSkills: readonly InstalledSkill[];
  readonly copies: readonly CopyResult[];
  readonly unresolved: readonly string[];
}
export type Outcome =
  | {
      readonly _tag: "Applied";
      readonly results: readonly AppliedChange[];
      /** Every copy the plan touched, as the Library recorded it. */
      readonly copies: readonly CopyResult[];
    }
  | {
      readonly _tag: "Incomplete";
      readonly results: readonly AppliedChange[];
      readonly reason: "destinations" | "reconciliation" | "request";
      readonly cause: ApplyError;
    };

export type PlanError =
  | LibraryStateReadError
  | InvalidIntent
  | StalePlan
  | CollectionRemovalMissing
  | InstalledSkills.Cause;
export type ApplyError =
  | PlanError
  | LibraryStateWriteError
  | InstalledSkillInvalid
  | InstalledSkillWouldDuplicate
  | InstalledSkillWouldReplaceLink
  | UninstallConflict
  | DestinationsIncomplete;

export interface Interface {
  readonly load: Effect.Effect<LibraryState, LibraryStateReadError>;
  /**
   * Plan against the Library the front end showed, never a fresh read: apply refuses the plan if
   * the Library has changed since.
   */
  readonly plan: (
    intents: readonly Intent[],
    options: { readonly base: LibraryState },
  ) => Effect.Effect<Plan, PlanError>;
  readonly apply: (plan: Plan) => Effect.Effect<Outcome, ApplyError>;
  /**
   * Store a Source's files as a Collection Version and save it. Nothing to preview or recheck: it
   * touches no skill folders, and what it imports exists only while the fetched Source does.
   */
  readonly import: {
    readonly collection: (
      request: Parameters<typeof importCollection>[0],
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof importCollection>>,
      Effect.Error<ReturnType<typeof importCollection>>
    >;
    readonly authored: (
      request: Parameters<typeof importAuthoredCollection>[0],
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof importAuthoredCollection>>,
      Effect.Error<ReturnType<typeof importAuthoredCollection>>
    >;
    /** An edited copy, as a new Version of its Skill. */
    readonly edit: (
      request: Parameters<typeof importEdit>[0],
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof importEdit>>,
      Effect.Error<ReturnType<typeof importEdit>>
    >;
  };
}
export class Service extends Context.Service<Service, Interface>()("skit/library/Library") {}

// ── Internals ────────────────────────────────────────────────────────────────────────────────────
/** What the installed skills batch has done on disk, so a failure records only real work. */
interface Recorder {
  /** Rows whose copies are on disk as recorded: verified installs, and pending displacements. */
  readonly onDisk: Map<InstalledSkillId, InstalledSkill>;
  /** Every recorded copy the batch touched, whose pending backups it settles. */
  readonly touched: Map<InstalledSkillId, InstalledSkill>;
  readonly copies: CopyResult[];
}

/** Operations report their cause inside Failed; callers see the cause itself, as before. */
const unwrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, InstalledSkills.Failed> =>
        Predicate.isTagged(error, "Library.InstalledSkillsFailed"),
      (failed) => Effect.fail(failed.cause),
    ),
  );

const markerFor = (
  copy: InstalledSkills.Copy,
  hash: InstalledSkill["expected_hash"],
): OwnershipMarker => ({
  schemaVersion: 5,
  installed_skill_id: copy.installedSkillId,
  skill_id: copy.skillId,
  skill_version_id: copy.skillVersionId,
  expected_hash: hash,
});

export const make = Effect.gen(function* () {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const writer = yield* Effect.context<FileSystem.FileSystem>();
  const importing = yield* Effect.context<TreeRequirements>();
  /** Every import holds the Library writer, and its staging ends with the import. */
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withLibraryWriter(Effect.scoped(effect)).pipe(
      Effect.provideService(LibraryStore, store),
      Effect.provide(writer),
      Effect.provide(importing),
    );

  /** Whether a recorded copy is still the one SKIT wrote. Changes nothing. */
  const ownership = Effect.fn("Library.ownership")(function* (copy: InstalledSkill) {
    const observed = yield* unwrap(files.inspect(copy.path));
    if (observed.entry._tag === "Absent" || observed.entry.facts === null)
      return { _tag: "Absent" as const, observed };
    const { marker } = observed.entry.facts;
    const hash = yield* unwrap(files.hash(copy.path));
    return marker.kind !== "valid" ||
      marker.marker.skill_id !== copy.skill_id ||
      marker.marker.installed_skill_id !== copy.installed_skill_id ||
      hash !== marker.marker.expected_hash
      ? { _tag: "Conflicted" as const, observed, hash }
      : { _tag: "Intact" as const, observed, hash };
  });

  /** A pending backup still holds the copy this row describes, so it explains its absence. */
  const displaced = Effect.fn("Library.displaced")(function* (copy: InstalledSkill) {
    return (yield* unwrap(files.backups.scan(copy.root, copy.installed_skill_id))).some(
      (backup) =>
        backup.marker.kind === "valid" &&
        backup.marker.marker.installed_skill_id === copy.installed_skill_id &&
        backup.marker.marker.expected_hash === copy.expected_hash,
    );
  });

  /** Move a recorded copy SKIT still owns to recovery. An edited one is reported or refused. */
  const uninstall = Effect.fn("Library.uninstall")(function* (
    recorder: Recorder,
    copy: InstalledSkill,
    onConflict: "throw" | "report",
    message: string,
  ) {
    recorder.touched.set(copy.installed_skill_id, copy);
    const owned = yield* ownership(copy);
    if (owned._tag === "Absent") return { kind: "absent" as const };
    if (owned._tag === "Conflicted") {
      if (onConflict === "throw") return yield* new UninstallConflict({ detail: message });
      recorder.copies.push({
        _tag: "Conflicted",
        copy: InstalledSkillStatus.conflicted(copy, owned.hash),
      });
      return { kind: "conflicted" as const, observed: owned.hash };
    }
    yield* unwrap(files.uninstall(copy.root, copy.path, copy.installed_skill_id));
    const pending = InstalledSkillStatus.pending(copy);
    recorder.onDisk.set(copy.installed_skill_id, pending);
    recorder.copies.push({ _tag: "Uninstalled", copy });
    return { kind: "uninstalled" as const, observed: owned.hash };
  });

  /** Whether a folder is one the user approved managing, compared by physical path. */
  const approved = Effect.fn("Library.approved")(function* (
    manage: ManageApproval | undefined,
    destination: string,
  ) {
    if (manage === undefined) return false;
    const target = (yield* unwrap(files.identify(destination))).key;
    for (const path of [manage.path, ...(manage.equalPaths ?? [])])
      if ((yield* unwrap(files.identify(path))).key === target) return true;
    return false;
  });

  /** Install one Skill at one destination: build, observe, decide, then do only that. */
  const install = Effect.fn("Library.install")(function* (
    recorder: Recorder,
    request: {
      readonly state: LibraryState;
      readonly copy: InstalledSkills.Copy;
      readonly destination: InstalledSkills.Destination;
      readonly name: string;
      readonly previous: InstalledSkill | undefined;
      readonly restoreDeleted: boolean;
      readonly manageIdentical: boolean;
      readonly manage?: ManageApproval;
      readonly accepted?: {
        readonly currentHash: InstalledSkill["expected_hash"];
        readonly marker: OwnershipMarker;
      };
    },
  ) {
    const { copy, destination, previous } = request;
    const name = yield* installedSkillName(request.name);
    const path = join(destination.root, name);
    yield* unwrap(files.prepare([destination.root]));
    const prior = previous?.installed_skill_id === copy.installedSkillId ? previous : undefined;
    const installedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* unwrap(files.build(copy, destination));
        const row: InstalledSkill = {
          installed_skill_id: copy.installedSkillId,
          skill_id: copy.skillId,
          skill_version_id: copy.skillVersionId,
          destination: destination.destination,
          root: destination.root,
          path,
          expected_hash: staged.hash,
          status: "pending",
          installed_at: installedAt,
        };
        const observed = yield* unwrap(files.inspect(path));
        const facts = observed.entry._tag === "Present" ? observed.entry.facts : null;
        if (
          observed.entry._tag === "Present" &&
          facts === null &&
          observed.entry.kind !== "SymbolicLink"
        )
          return yield* new InstalledSkillInvalid({ detail: `Not a skill folder: ${path}` });
        // Decided against the hash an installed copy is verified with; an unreadable folder fails.
        const current = facts === null ? undefined : yield* unwrap(files.hash(path));
        const decided: Result.Result<Decision, "ManageTargetChanged" | "ManageContentMismatch"> =
          facts !== null && current !== undefined
            ? decide(
                {
                  marker: facts.marker,
                  hash: current,
                  directory:
                    observed.entry._tag === "Present" && observed.entry.kind === "Directory",
                  insideRepository: facts.insideRepository,
                  holdsRepositoryFiles: facts.holdsRepositoryFiles,
                  approvedForManage: yield* approved(request.manage, path),
                },
                {
                  installedSkillId: copy.installedSkillId,
                  skillId: copy.skillId,
                  skillVersionId: copy.skillVersionId,
                  hash: staged.hash,
                  recordedHash: prior?.expected_hash,
                  manage:
                    request.manage === undefined ? undefined : { hash: request.manage.currentHash },
                  manageIdentical: request.manageIdentical,
                  replacement:
                    request.accepted === undefined
                      ? undefined
                      : { hash: request.accepted.currentHash, marker: request.accepted.marker },
                },
              )
            : Result.succeed(
                !request.restoreDeleted &&
                  prior?.status === "suppressed" &&
                  prior.suppression_reason === "native_delete" &&
                  !(yield* displaced(prior))
                  ? { _tag: "KeepSuppressed" }
                  : { _tag: "Install" },
              );
        if (Result.isFailure(decided))
          return yield* new InstalledSkillInvalid({ detail: `${decided.failure}: ${path}` });
        const decision = decided.success;
        const written = (installed: InstalledSkills.Installed) => {
          const result = InstalledSkillStatus.installed(row, installed.hash);
          recorder.onDisk.set(result.installed_skill_id, result);
          recorder.copies.push({ _tag: "Installed", copy: result });
          return result;
        };
        const committed = (
          operation: Effect.Effect<InstalledSkills.Installed, InstalledSkills.Failed>,
        ) =>
          operation.pipe(
            Effect.tapError((failure) =>
              Effect.gen(function* () {
                if (
                  failure._tag !== "Library.InstalledSkillsFailed" ||
                  Option.isNone(failure.displaced)
                )
                  return;
                // An unverified successor now stands where the original was: never call it pending.
                const now = yield* files.inspect(path).pipe(Effect.option);
                if (prior !== undefined && Option.isSome(now) && now.value.entry._tag === "Absent")
                  recorder.onDisk.set(
                    prior.installed_skill_id,
                    InstalledSkillStatus.pending(prior),
                  );
              }),
            ),
            unwrap,
            Effect.map(written),
          );
        switch (decision._tag) {
          case "KeepSuppressed": {
            const result = InstalledSkillStatus.suppressed(
              row,
              prior?.status === "suppressed" ? prior.suppressed_at : undefined,
            );
            recorder.copies.push({ _tag: "Suppressed", copy: result });
            return result;
          }
          case "Manage":
            return yield* committed(
              files.manage(staged, markerFor(copy, staged.hash), observed, decision.verification),
            );
          case "Conflict": {
            if (decision.edited)
              yield* unwrap(
                files.backUp(
                  path,
                  installedSkillVariantPath(
                    store.variantsPath,
                    destination.destination,
                    name,
                    decision.hash,
                  ),
                ),
              );
            const result = InstalledSkillStatus.conflicted(
              row,
              decision.hash,
              decision.edited ? decision.expectedHash : row.expected_hash,
            );
            recorder.copies.push({ _tag: "Conflicted", copy: result });
            return result;
          }
          case "Unchanged": {
            const result = InstalledSkillStatus.installed(row);
            recorder.copies.push({ _tag: "Unchanged", copy: result });
            return result;
          }
          case "Replace":
          case "Install":
            return yield* committed(files.install(staged, markerFor(copy, staged.hash), observed));
        }
      }),
    );
  });

  /**
   * One batch of copy changes over `loaded`. `stage` edits a private candidate and records the real
   * work on disk; nothing is rolled back. Saves once; a failure saves only what is really on disk:
   * verified copies, and copies moved aside with nothing in their place, as pending. Pending backups
   * of every copy the batch touched are then kept, or discarded when `loaded` proves them reproducible.
   */
  const batch = Effect.fn("Library.batch")(function* <E, R>(
    store: LibraryStore["Service"],
    loaded: LibraryState,
    /** Edits `candidate` in place, or returns the state to save instead. */
    stage: (
      recorder: Recorder,
      candidate: LibraryState,
    ) => Effect.Effect<LibraryState | void, E, R>,
  ) {
    const recorder: Recorder = { onDisk: new Map(), touched: new Map(), copies: [] };
    const candidate = structuredClone(loaded);
    const recordFailure = Effect.suspend(() => {
      if (recorder.onDisk.size === 0) return Effect.void;
      const next = structuredClone(loaded);
      for (const row of recorder.onDisk.values()) {
        const index = next.installed_skills.findIndex(
          (item) => item.installed_skill_id === row.installed_skill_id,
        );
        if (index < 0) next.installed_skills.push(row);
        else next.installed_skills[index] = row;
      }
      return store.save(next, loaded);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Installed skills changed, but the Library could not record them", cause),
      ),
    );
    const next =
      (yield* stage(recorder, candidate).pipe(Effect.onError(() => recordFailure))) ?? candidate;
    const pending = yield* Effect.forEach([...recorder.touched.values()], (copy) =>
      unwrap(files.backups.scan(copy.root, copy.installed_skill_id)).pipe(
        Effect.map((backups) => backups.map((backup) => ({ backup, copy }))),
      ),
    ).pipe(
      Effect.map((groups) => groups.flat()),
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("Installed-skill backups stayed pending", cause), []),
      ),
    );
    // The save also proves `loaded` is still the Library's, which settling a backup relies on.
    if (
      recorder.onDisk.size > 0 ||
      pending.length > 0 ||
      libraryStateRevision(next) !== libraryStateRevision(loaded)
    )
      yield* store.save(next, loaded);
    for (const { backup, copy } of pending)
      yield* Effect.gen(function* () {
        const reproducible = yield* files.backups
          .check(backup, loaded, store.originalsPath, copy.installed_skill_id)
          .pipe(Effect.orElseSucceed(() => false));
        yield* reproducible ? files.backups.discard(backup) : files.backups.keep(backup);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Library changed, but installed-skill backups stayed pending", cause),
        ),
      );
    return { state: next, copies: recorder.copies };
  });

  /**
   * Bring this device's skill folders in line with `loaded` for one request: uninstall what no
   * setting asks for, install what is enabled at each destination, then uninstall former copies only
   * after every successor is in place.
   */
  const updateInstalledSkills = Effect.fn("Library.updateInstalledSkills")(function* (
    store: LibraryStore["Service"],
    loaded: LibraryState,
    options: {
      readonly scope: Request["scope"];
      /** Install what is enabled at the scope; without it, only uninstall leftovers. */
      readonly install: boolean;
      /** Enabling puts back copies of these Skills that the user deleted. */
      readonly restoreDeleted: readonly string[];
      /** Manage a folder that already holds exactly SKIT's bytes. */
      readonly manageIdentical: boolean;
      /**
       * First uninstall copies no setting asks for: none, those at inactive or former destinations,
       * or also those whose Skill is no longer enabled.
       */
      readonly leftovers: "none" | "inactive" | "all";
      /** Touch only these Skills: selection, uninstalls and relocation. */
      readonly only?: readonly SkillId[];
      /** Folders the user approved managing, as previewed. */
      readonly manage?: ManageApproval;
      /** Edited copies the user accepted as the selected Version, as previewed. */
      readonly acceptedCopies?: ReadonlyMap<
        string,
        { readonly currentHash: InstalledSkill["expected_hash"]; readonly marker: OwnershipMarker }
      >;
    },
    targets: readonly InstalledSkills.Destination[],
  ) {
    return yield* batch(store, loaded, (recorder, candidate) =>
      Effect.gen(function* () {
        const removeRow = (id: InstalledSkillId) => {
          const index = candidate.installed_skills.findIndex(
            (item) => item.installed_skill_id === id,
          );
          if (index >= 0) candidate.installed_skills.splice(index, 1);
        };
        // Copies at an inactive or former destination are never wanted.
        const intent = deviceInstallationIntent(candidate);
        const active = options.leftovers === "none" ? [] : yield* unwrap(files.active);
        for (const copy of options.leftovers === "none"
          ? []
          : leftoverSkills(candidate, {
              activeDestinations: active,
              enabled: intent.globals[0]?.enabled ?? [],
              inactiveOnly: options.leftovers === "inactive",
              ...(options.only === undefined ? {} : { onlySkillIds: options.only }),
            })) {
          const skill = candidate.skills.find((item) => item.skill_id === copy.skill_id);
          if (skill === undefined) continue;
          // An edited copy at an active destination is refused; at an inactive or former one it
          // is kept and reported, so it cannot block every later update.
          const result = yield* uninstall(
            recorder,
            copy,
            active.some((destination) => destination === copy.destination) ? "throw" : "report",
            `Refusing to remove modified ${skill.name} at ${copy.path}`,
          );
          if (result.kind === "conflicted")
            candidate.installed_skills[candidate.installed_skills.indexOf(copy)] =
              InstalledSkillStatus.conflicted(copy, result.observed);
          else removeRow(copy.installed_skill_id);
        }
        if (!options.install) return;
        const former: InstalledSkill[] = [];
        for (const target of targets) {
          const state = structuredClone(candidate);
          const scope = options.scope;
          const enabled = enabledAt(state, scope);
          if (enabled === undefined)
            return yield* new InstalledSkillInvalid({ detail: "Nothing is enabled at this scope" });
          const bound = enabledSkillIds(state, enabled.enabled).filter(
            (id) => options.only === undefined || options.only.includes(id),
          );
          const selected = state.skills
            .filter((skill) => bound.includes(skill.skill_id))
            .flatMap((skill) => {
              const version = currentSkillVersion(state, skill);
              return version === undefined || versionBacking(state, skill, version) === undefined
                ? []
                : [{ skill, version }];
            });
          if (selected.length !== bound.length)
            return yield* new InstalledSkillInvalid({
              detail: "An enabled Skill has no selected retained Version",
            });
          // Compare physical roots so a configured symlink alias cannot retire the active copy.
          const keys = new Map<string, { key: string; canonicalPath: string }>();
          for (const root of new Set([
            target.root,
            ...state.installed_skills
              .filter((item) => item.destination === target.destination)
              .map((item) => item.root),
            ...state.repositories.map((repository) => repository.root),
          ]))
            keys.set(root, yield* unwrap(files.identify(root)));
          const atTarget = (copy: InstalledSkill) =>
            copy.destination === target.destination &&
            (options.only === undefined || options.only.includes(copy.skill_id)) &&
            keys.get(copy.root)?.key === keys.get(target.root)?.key;
          const formerHere =
            scope.kind === "global"
              ? state.installed_skills.filter(
                  (copy) =>
                    copy.destination === target.destination &&
                    !atTarget(copy) &&
                    bound.includes(copy.skill_id) &&
                    !repositorySelectsInstalledSkill(state, copy) &&
                    !state.repositories.some(
                      (repository) =>
                        enabledSkillIds(state, repository.enabled).includes(copy.skill_id) &&
                        pathIsWithin(
                          keys.get(repository.root)?.canonicalPath ?? repository.root,
                          keys.get(copy.root)?.canonicalPath ?? copy.root,
                        ),
                    ),
                )
              : [];
          // Refuse an edited former copy before installing anything or removing any old copy.
          for (const copy of formerHere)
            if ((yield* ownership(copy))._tag === "Conflicted")
              return yield* new UninstallConflict({
                detail: `Refusing to relocate modified Skill from ${copy.path}`,
              });
          for (const existing of candidate.installed_skills.filter(
            (copy) => atTarget(copy) && !bound.includes(copy.skill_id),
          )) {
            const skill = candidate.skills.find((item) => item.skill_id === existing.skill_id);
            if (skill === undefined) continue;
            // A copy without SKIT's marker was never SKIT's to remove: disabling drops the record and
            // leaves the folder. A managed copy edited since SKIT wrote it is refused.
            const owned = yield* unwrap(files.inspect(existing.path));
            const markerAbsent =
              owned.entry._tag === "Absent" ||
              owned.entry.facts === null ||
              owned.entry.facts.marker.kind === "absent";
            yield* uninstall(
              recorder,
              existing,
              markerAbsent ? "report" : "throw",
              `Refusing to disable ${skill.name}: ${existing.path} was edited after SKIT wrote it`,
            );
          }
          candidate.installed_skills.splice(
            0,
            candidate.installed_skills.length,
            ...candidate.installed_skills.filter((copy) => !atTarget(copy)),
          );
          for (const { skill, version } of selected) {
            const previous = state.installed_skills.find(
              (copy) => copy.skill_id === skill.skill_id && atTarget(copy),
            );
            const policy = enabled.invocation_policies?.[skill.skill_id];
            const accepted =
              previous === undefined
                ? undefined
                : options.acceptedCopies?.get(previous.installed_skill_id);
            const installed = yield* install(recorder, {
              state: candidate,
              copy: {
                state: candidate,
                originalsPath: store.originalsPath,
                installedSkillId: previous?.installed_skill_id ?? makeInstalledSkillId(),
                skillId: skill.skill_id,
                skillVersionId: version.skill_version_id,
                invocationIntent:
                  policy === undefined
                    ? declaredInvocationIntent
                    : overrideInvocationIntent(policy),
              },
              destination: target,
              name: skill.name,
              previous,
              restoreDeleted: options.restoreDeleted.includes(skill.skill_id),
              manageIdentical: options.manageIdentical,
              ...(options.manage === undefined ? {} : { manage: options.manage }),
              ...(accepted === undefined ? {} : { accepted }),
            });
            recorder.touched.set(installed.installed_skill_id, installed);
            candidate.installed_skills.push(installed);
            // Keep the last working copy when the new destination is blocked or locally modified.
            if (installed.status === "installed")
              former.push(...formerHere.filter((copy) => copy.skill_id === skill.skill_id));
          }
        }
        // Every successor at every destination is in place before any former copy is uninstalled.
        for (const copy of former)
          if ((yield* ownership(copy))._tag === "Conflicted")
            return yield* new UninstallConflict({
              detail: `Refusing to relocate modified Skill from ${copy.path}`,
            });
        for (const copy of former) {
          yield* uninstall(
            recorder,
            copy,
            "throw",
            `Refusing to relocate modified Skill from ${copy.path}`,
          );
          removeRow(copy.installed_skill_id);
        }
      }),
    );
  });

  /** Everything plan shows and apply rechecks: the changes, routes and observed paths. */
  const preview = Effect.fn("Library.preview")(function* (
    state: LibraryState,
    intents: readonly EnabledIntent[],
  ) {
    const requests = (yield* Effect.forEach(intents, (intent) =>
      expandIntent(state, intent),
    )).flat();
    let candidate = state;
    const changes: BindingChange[] = [];
    const copies: CopyChange[] = [];
    const routes: Plan["routes"][number][] = [];
    const paths = new Set<string>(state.installed_skills.map((copy) => copy.path));
    for (const request of requests) {
      const { plan, skillIds, newlyEnabledSkills, hasList } = yield* calculateEnabled(
        candidate,
        request,
      );
      const destinations = yield* unwrap(files.destinations(plan.scope));
      routes.push({ scope: plan.scope, destinations });
      const names = skillsToCheckForDuplicates(
        candidate,
        plan.scope,
        request.enabled ? plan.skills : [],
        newlyEnabledSkills,
      );
      const duplicates = yield* unwrap(files.duplicates.scan(plan.scope, names));
      // Duplicates are not evidence: apply scans for them again and refuses by policy.
      const unmanaged: { destination: "agents" | "claude"; path: string }[] = [];
      let repair = false;
      const enabledIds = enabledSkillIds(candidate, plan.enabled);
      for (const target of destinations) {
        for (const id of new Set([...skillIds, ...enabledIds])) {
          const skill = candidate.skills.find((item) => item.skill_id === id);
          if (skill === undefined) continue;
          const path = join(target.root, yield* installedSkillName(skill.name));
          const previous = state.installed_skills.find((copy) => copy.path === path);
          paths.add(path);
          if (enabledIds.includes(id))
            copies.push({ _tag: "Install", skillId: id, destination: target.destination, path });
          const observed = yield* unwrap(files.inspect(path));
          const facts = observed.entry._tag === "Present" ? observed.entry.facts : null;
          if (
            request.enabled &&
            skillIds.includes(id) &&
            observed.entry._tag === "Present" &&
            observed.entry.kind !== "SymbolicLink" &&
            facts?.marker.kind !== "valid"
          )
            unmanaged.push({ destination: target.destination, path });
          if (!plan.changed && request.enabled && skillIds.includes(id))
            repair ||=
              previous === undefined ||
              previous.status !== "installed" ||
              facts === null ||
              facts.hash !== previous.expected_hash;
          for (const version of skill.versions) {
            const backing = versionBacking(state, skill, version);
            if (backing) paths.add(collectionVersionPath(store.originalsPath, backing.copy.hash));
          }
        }
        if (!plan.changed && !request.enabled && hasList) {
          for (const copy of candidate.installed_skills.filter(
            (copy) =>
              copy.root === target.root &&
              copy.destination === target.destination &&
              !enabledIds.includes(copy.skill_id),
          ))
            repair ||= (yield* unwrap(files.inspect(copy.path))).entry._tag !== "Absent";
        }
      }
      for (const copy of candidate.installed_skills)
        if (
          !destinations.some((target) => target.destination === copy.destination) ||
          (destinations.some(
            (target) => target.destination === copy.destination && target.root === copy.root,
          ) &&
            !enabledIds.includes(copy.skill_id))
        )
          copies.push({
            _tag: "Uninstall",
            skillId: copy.skill_id,
            destination: copy.destination,
            path: copy.path,
          });
      changes.push({
        ...plan,
        _tag: request.enabled ? "Enable" : "Disable",
        ...(repair ? { repair } : {}),
        ...(duplicates.copies.length ? { duplicates: duplicates.copies } : {}),
        ...(duplicates.warnings.length ? { warnings: duplicates.warnings } : {}),
        ...(unmanaged.length ? { unmanaged_destinations: unmanaged } : {}),
      });
      if (plan.changed) candidate = setEnabledAt(candidate, plan.scope, plan);
    }
    return { requests, changes, routes, paths: [...paths], copies };
  });

  /** What removing a Collection changes: its Skills, and every copy of them, observed. */
  const previewRemoval = Effect.fn("Library.previewRemoval")(function* (
    state: LibraryState,
    removal: Remove,
  ) {
    if (!state.collections.some((item) => item.collection_id === removal.collectionId))
      return yield* new CollectionRemovalMissing({ collection_id: removal.collectionId });
    const skillIds = state.skills
      .filter((skill) => skill.collection_id === removal.collectionId)
      .map((skill) => skill.skill_id);
    const copies = state.installed_skills.filter((copy) => skillIds.includes(copy.skill_id));
    const paths = copies.map((copy) => copy.path);
    const changes: Change[] = [
      { _tag: "Remove", collectionId: removal.collectionId, skillIds },
      ...copies.map((copy): CopyChange => ({
        _tag: "Uninstall",
        skillId: copy.skill_id,
        destination: copy.destination,
        path: copy.path,
      })),
    ];
    return { changes, paths };
  });

  /** A plan either changes what is enabled, or removes or updates one Collection on its own. */
  const split = (
    intents: readonly Intent[],
  ):
    | { readonly _tag: "Enabled"; readonly intents: readonly EnabledIntent[] }
    | { readonly _tag: "Remove"; readonly removal: Remove }
    | { readonly _tag: "Update"; readonly update: Update }
    | { readonly _tag: "Install"; readonly install: Install }
    | { readonly _tag: "Uninstall"; readonly uninstall: Uninstall }
    | { readonly _tag: "Mixed" } => {
    const enabled = intents.filter(
      (intent): intent is EnabledIntent => intent._tag === "Enable" || intent._tag === "Disable",
    );
    const [only] = intents;
    if (enabled.length === intents.length) return { _tag: "Enabled", intents: enabled };
    if (intents.length !== 1 || only === undefined) return { _tag: "Mixed" };
    return only._tag === "Remove"
      ? { _tag: "Remove", removal: only }
      : only._tag === "Update"
        ? { _tag: "Update", update: only }
        : only._tag === "Install"
          ? { _tag: "Install", install: only }
          : only._tag === "Uninstall"
            ? { _tag: "Uninstall", uninstall: only }
            : { _tag: "Mixed" };
  };
  const mixed = () => new InvalidIntent({ detail: "Remove or update one Collection on its own" });

  /** What updating a Collection's copies touches: every scope enabling it, at every destination. */
  const previewUpdate = Effect.fn("Library.previewUpdate")(function* (
    state: LibraryState,
    update: Update,
  ) {
    const enables = (id: string) =>
      state.skills.some(
        (skill) => skill.skill_id === id && skill.collection_id === update.collectionId,
      );
    const routes: Plan["routes"][number][] = [];
    const changes: Change[] = [];
    const paths = new Set<string>(state.installed_skills.map((copy) => copy.path));
    for (const list of update.collectionId === undefined
      ? deviceInstallationIntent(state).byScope
      : enabledByScope(state).filter((list) =>
          list.enabled.some((item) =>
            "collection" in item ? item.collection === update.collectionId : enables(item.skill),
          ),
        )) {
      const destinations = yield* unwrap(files.destinations(list.scope));
      routes.push({ scope: list.scope, destinations });
      for (const target of destinations)
        for (const id of enabledSkillIds(state, list.enabled)) {
          const skill = state.skills.find((item) => item.skill_id === id);
          if (skill === undefined) continue;
          const path = join(target.root, yield* installedSkillName(skill.name));
          paths.add(path);
          changes.push({ _tag: "Install", skillId: id, destination: target.destination, path });
        }
    }
    return { changes, routes, paths: [...paths] };
  });

  /** What installing selected Skills at one destination touches. */
  const previewInstall = Effect.fn("Library.previewInstall")(function* (
    state: LibraryState,
    install: Install,
  ) {
    const changes: Change[] = [];
    const ids =
      install.only ?? enabledSkillIds(state, enabledAt(state, install.scope)?.enabled ?? []);
    const paths = new Set<string>(
      state.installed_skills.filter((copy) => ids.includes(copy.skill_id)).map((copy) => copy.path),
    );
    for (const id of ids) {
      const skill = state.skills.find((item) => item.skill_id === id);
      if (skill === undefined) continue;
      const path = join(install.destination.root, yield* installedSkillName(skill.name));
      paths.add(path);
      changes.push({
        _tag: "Install",
        skillId: id,
        destination: install.destination.destination,
        path,
      });
    }
    return { changes, paths: [...paths] };
  });

  /**
   * What one plan is, for every intent alike: the changes it shows, the routes and paths it rests
   * on, the policy it refuses by, and the work apply runs once all of that is rechecked.
   */
  interface Work {
    readonly changes: readonly Change[];
    readonly routes: Plan["routes"];
    readonly paths: readonly string[];
    readonly refuse: Effect.Effect<void, ApplyError>;
    readonly run: Effect.Effect<Outcome, ApplyError>;
  }
  const applied = (copies: readonly CopyResult[]): Outcome => ({
    _tag: "Applied",
    results: [],
    copies,
  });

  const prepare = Effect.fn("Library.prepare")(function* (
    base: LibraryState,
    intents: readonly Intent[],
  ): Effect.fn.Return<Work, PlanError> {
    const kind = split(intents);
    switch (kind._tag) {
      case "Mixed":
        return yield* mixed();
      case "Remove": {
        const { changes, paths } = yield* previewRemoval(base, kind.removal);
        return {
          changes,
          routes: [],
          paths,
          refuse: Effect.void,
          run: Effect.map(applyRemoval(base, kind.removal), applied),
        };
      }
      case "Uninstall": {
        const removal = kind.uninstall;
        const listed = base.installed_skills.filter((copy) =>
          removal.copies.includes(copy.installed_skill_id),
        );
        return {
          changes: listed.map((copy): Change => ({
            _tag: "Uninstall",
            skillId: copy.skill_id,
            destination: copy.destination,
            path: copy.path,
          })),
          routes: [],
          paths: listed.map((copy) => copy.path),
          refuse: Effect.void,
          run: Effect.gen(function* () {
            const { copies } = yield* batch(store, base, (recorder, candidate) =>
              Effect.gen(function* () {
                for (const id of removal.copies) {
                  const copy = candidate.installed_skills.find(
                    (item) => item.installed_skill_id === id,
                  );
                  if (copy === undefined) continue;
                  yield* uninstall(
                    recorder,
                    copy,
                    "throw",
                    `Refusing to remove modified Skill at ${copy.path}`,
                  );
                  if (removal.drop.includes(id))
                    candidate.installed_skills.splice(candidate.installed_skills.indexOf(copy), 1);
                  else if (copy.status !== "suppressed")
                    candidate.installed_skills[candidate.installed_skills.indexOf(copy)] =
                      InstalledSkillStatus.pending(copy);
                }
              }),
            );
            return applied(copies);
          }),
        };
      }
      case "Install": {
        const install = kind.install;
        const { changes, paths } = yield* previewInstall(base, install);
        return {
          changes,
          routes: [],
          paths,
          refuse: Effect.void,
          run: Effect.gen(function* () {
            const updated = yield* updateInstalledSkills(
              store,
              base,
              {
                scope: install.scope,
                install: true,
                restoreDeleted: install.restoreDeleted,
                manageIdentical: install.manageIdentical,
                leftovers: "none",
                ...(install.only === undefined ? {} : { only: install.only }),
                ...(install.manage === undefined ? {} : { manage: install.manage }),
                acceptedCopies: new Map(
                  (install.acceptedCopies ?? []).map((copy) => [
                    copy.installedSkillId,
                    { currentHash: copy.currentHash, marker: copy.marker },
                  ]),
                ),
              },
              [install.destination],
            );
            return applied(updated.copies);
          }),
        };
      }
      case "Update": {
        const update = kind.update;
        const { changes, routes: planned, paths } = yield* previewUpdate(base, update);
        return {
          changes,
          routes: planned,
          paths,
          refuse: Effect.void,
          run: Effect.gen(function* () {
            let state = base;
            const copies: CopyResult[] = [];
            // Leftovers once, first: of every Skill nothing enables, when updating everything.
            const leftovers = update.collectionId === undefined ? "all" : "inactive";
            const routes =
              planned.length > 0
                ? planned
                : [{ scope: { kind: "global" as const }, destinations: [] }];
            for (const [index, route] of routes.entries()) {
              const updated = yield* updateInstalledSkills(
                store,
                state,
                {
                  scope: route.scope,
                  install: planned.length > 0,
                  restoreDeleted: [],
                  manageIdentical: false,
                  leftovers: index === 0 ? leftovers : "none",
                },
                route.destinations,
              );
              state = updated.state;
              copies.push(...updated.copies);
            }
            return applied(copies);
          }),
        };
      }
      case "Enabled": {
        const recomputed = yield* preview(base, kind.intents);
        return {
          changes: [...recomputed.changes, ...recomputed.copies],
          routes: recomputed.routes,
          paths: recomputed.paths,
          refuse: Effect.gen(function* () {
            let candidate = base;
            for (const request of recomputed.requests) {
              const calculated = yield* calculateEnabled(candidate, request);
              const targets = yield* unwrap(files.destinations(request.scope));
              yield* refuseDuplicates(candidate, request, calculated, targets);
              if (calculated.plan.changed)
                candidate = setEnabledAt(candidate, request.scope, calculated.plan);
            }
          }),
          run: Effect.gen(function* () {
            let revision = libraryStateRevision(base);
            // What this writer itself last saved: a result never claims another writer's state.
            let saved: LibraryState | undefined;
            // Every save in this batch must build on the batch's own last save.
            const guarded = {
              ...store,
              save: (next: LibraryState, previous: LibraryState) =>
                libraryStateRevision(previous) !== revision
                  ? Effect.fail(new LibraryChanged({ path: store.statePath }))
                  : store.save(next, previous).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          revision = libraryStateRevision(next);
                          saved = next;
                        }),
                      ),
                    ),
            };
            let state = base;
            const results: AppliedChange[] = [];
            for (const [index, request] of recomputed.requests.entries()) {
              const accepted = { value: false };
              const change = recomputed.changes[index];
              const destinations = recomputed.routes[index]?.destinations ?? [];
              if (change === undefined) return yield* stale();
              const attempted = yield* applyRequest(
                guarded,
                state,
                request,
                destinations,
                accepted,
              ).pipe(
                Effect.catchTag("LibraryChanged", () => Effect.fail(stale())),
                Effect.result,
              );
              if (Result.isFailure(attempted) && !accepted.value) {
                if (results.length === 0) return yield* Effect.fail(attempted.failure);
                return {
                  _tag: "Incomplete",
                  results,
                  reason: "request",
                  cause: attempted.failure,
                } satisfies Outcome;
              }
              const durable = yield* store.load;
              const recorded = Result.isSuccess(attempted)
                ? attempted.success.state
                : (saved ?? state);
              if (Result.isSuccess(attempted) && libraryStateRevision(durable) !== revision)
                return yield* stale();
              const selected = yield* calculateEnabled(state, request);
              const result = finish(
                change,
                selected.skillIds,
                destinations,
                Result.isSuccess(attempted) ? attempted.success.copies : [],
                recorded,
              );
              results.push(result);
              state = recorded;
              if (Result.isFailure(attempted))
                return {
                  _tag: "Incomplete",
                  results,
                  reason: "reconciliation",
                  cause: attempted.failure,
                } satisfies Outcome;
              if (result.unresolved.length)
                return {
                  _tag: "Incomplete",
                  results,
                  reason: "destinations",
                  cause: new DestinationsIncomplete({ paths: result.unresolved }),
                } satisfies Outcome;
            }
            return {
              _tag: "Applied",
              results,
              copies: results.flatMap((result) => result.copies),
            } satisfies Outcome;
          }),
        };
      }
    }
  });

  const plan: Interface["plan"] = Effect.fn("Library.plan")(function* (intents, options) {
    const state = structuredClone(options.base);
    const reviewed = structuredClone(intents);
    const work = yield* prepare(state, reviewed);
    return {
      baseRevision: libraryStateRevision(state),
      intents: reviewed,
      changes: [...work.changes],
      routes: work.routes,
      observed: yield* Effect.forEach([...new Set(work.paths)].sort(), (path) =>
        unwrap(files.inspect(path)),
      ),
    };
  });

  /** Remove a Collection exactly as planned; a failed batch saves only the copies it moved aside. */
  const applyRemoval = Effect.fn("Library.applyRemoval")(function* (
    base: LibraryState,
    removal: Remove,
  ) {
    const removedSkillIds = new Set<string>(
      base.skills
        .filter((skill) => skill.collection_id === removal.collectionId)
        .map((skill) => skill.skill_id),
    );
    const { copies } = yield* batch(store, base, (recorder, candidate) =>
      Effect.gen(function* () {
        for (const copy of candidate.installed_skills.filter((item) =>
          removedSkillIds.has(item.skill_id),
        )) {
          const skill = candidate.skills.find((item) => item.skill_id === copy.skill_id);
          if (skill === undefined) continue;
          yield* uninstall(
            recorder,
            copy,
            "throw",
            `Refusing to remove modified ${skill.name} at ${copy.path}`,
          );
        }
        // Only a batch that uninstalled every copy removes the Collection.
        const imports = candidate.imports.filter(
          (sourceImport) => sourceImport.collection_id !== removal.collectionId,
        );
        const surviving = new Set(
          imports.map((sourceImport) => sourceImport.collection_version_id),
        );
        const pruned = removeFromEnabled(candidate, {
          skills: removedSkillIds,
          collections: new Set([removal.collectionId]),
        });
        return {
          ...pruned,
          collections: pruned.collections.filter(
            (item) => item.collection_id !== removal.collectionId,
          ),
          installed_skills: pruned.installed_skills.filter(
            (item) => !removedSkillIds.has(item.skill_id),
          ),
          skills: pruned.skills.filter((skill) => !removedSkillIds.has(skill.skill_id)),
          imports,
          collection_versions: pruned.collection_versions.filter((copy) =>
            surviving.has(copy.collection_version_id),
          ),
        };
      }),
    );
    return copies;
  });

  /** Policy: refuse a duplicate the request did not allow, or a link SKIT's copy would replace. */
  const refuseDuplicates = Effect.fn("Library.refuseDuplicates")(function* (
    current: LibraryState,
    request: Request,
    calculated: Calculated,
    targets: readonly InstalledSkills.Destination[],
  ) {
    const names = skillsToCheckForDuplicates(
      current,
      request.scope,
      request.enabled ? calculated.plan.skills : [],
      calculated.newlyEnabledSkills,
    );
    const duplicates = yield* unwrap(files.duplicates.scan(request.scope, names));
    if (request.enabled && duplicates.copies.length) {
      if (!request.allowDuplicate) {
        // Setup consent covers only these exact links, while they are still the links reviewed.
        const remaining: InstalledSkills.Duplicate[] = [];
        for (const duplicate of duplicates.copies) {
          const aliases = [];
          for (const alias of duplicate.aliases) {
            const reviewed = request.setup?.approvedSymlinks.find(
              (item) => item.path === alias.path && item.canonicalPath === duplicate.canonicalPath,
            );
            if (reviewed !== undefined) {
              const entry = (yield* unwrap(files.inspect(alias.path))).entry;
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
        if (remaining.length)
          return yield* new InstalledSkillWouldDuplicate({ duplicates: remaining });
      } else {
        const paths = targets.flatMap((target) =>
          calculated.plan.skills.map((name) => join(target.root, name)),
        );
        const links = duplicates.copies.flatMap((copy) =>
          copy.aliases
            .filter(
              (alias) =>
                alias.via === "symlink" &&
                alias.linkPath === alias.path &&
                paths.includes(alias.path),
            )
            .map((alias) => alias.path),
        );
        if (links.length) return yield* new InstalledSkillWouldReplaceLink({ links });
      }
    }
  });

  /** One request: refuse what policy forbids, save intent, then update installed skills. */
  const applyRequest = Effect.fn("Library.applyRequest")(function* (
    store: LibraryStore["Service"],
    expected: LibraryState,
    request: Request,
    destinations: readonly InstalledSkills.Destination[],
    accepted: { value: boolean },
  ) {
    const current = yield* store.load;
    if (libraryStateRevision(current) !== libraryStateRevision(expected)) return yield* stale();
    const calculated = yield* calculateEnabled(current, request);
    const targets = yield* unwrap(files.destinations(request.scope));
    if (JSON.stringify(targets) !== JSON.stringify(destinations))
      return yield* stale("Installed agent targets changed after preview");
    yield* refuseDuplicates(current, request, calculated, targets);
    if (request.enabled) yield* unwrap(files.prepare(targets.map((target) => target.root)));
    let state = current;
    if (calculated.plan.changed) {
      state = setEnabledAt(current, request.scope, calculated.plan);
      yield* store.save(state, current);
    }
    accepted.value = true;
    const updated = yield* updateInstalledSkills(
      store,
      state,
      {
        scope: request.scope,
        install: calculated.hasList,
        restoreDeleted: request.enabled ? calculated.skillIds : [],
        manageIdentical: request.enabled,
        leftovers: "inactive",
        ...(request.setup?.onlySelected ? { only: calculated.skillIds } : {}),
        ...(request.setup?.manage === undefined ? {} : { manage: request.setup.manage }),
      },
      targets,
    );
    state = updated.state;
    if (!request.enabled) {
      const pruned = pruneEmptyEnabled(state);
      if (pruned !== state) yield* store.save(pruned, state);
      state = pruned;
    }
    return { state, calculated, copies: updated.copies };
  });

  /** The public result, derived only from what the Library recorded. */
  const finish = (
    change: BindingChange,
    skillIds: readonly string[],
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
              !paths.some(
                (path) => path.path === copy.path && path.destination === copy.destination,
              ),
          )
          .map((copy) => copy.path),
      ]),
    ];
    return {
      change,
      intent: change.changed ? "saved" : "unchanged",
      revision: libraryStateRevision(state),
      installedSkills,
      copies,
      unresolved,
    };
  };

  const apply: Interface["apply"] = Effect.fn("Library.apply")(function* (reviewed) {
    // A plan is never a source of write coordinates or Library rows.
    const input = structuredClone(reviewed);
    return yield* withLibraryWriter(
      Effect.gen(function* () {
        const base = yield* store.load;
        if (libraryStateRevision(base) !== input.baseRevision)
          return yield* split(input.intents)._tag === "Enabled"
            ? stale()
            : new LibraryChanged({ path: store.statePath });
        const work = yield* prepare(base, input.intents);
        // A refusal by policy says more than "changed since preview", so it is checked first.
        yield* work.refuse;
        if (
          JSON.stringify(work.routes) !== JSON.stringify(input.routes) ||
          JSON.stringify([...new Set(work.paths)].sort()) !==
            JSON.stringify(input.observed.map((item) => item.path))
        )
          return yield* stale("Installed agent targets or paths changed after preview");
        yield* unwrap(files.check(input.observed)).pipe(
          Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
            Effect.fail(stale(error.message)),
          ),
        );
        return yield* work.run;
      }),
    ).pipe(Effect.provideService(LibraryStore, store), Effect.provide(writer));
  });

  return Service.of({
    load: store.load,
    plan,
    apply,
    import: {
      collection: (request) => owned(importCollection(request)),
      authored: (request) => owned(importAuthoredCollection(request)),
      edit: (request) => owned(importEdit(request)),
    },
  });
});
export const layer = Layer.effect(Service, make);
export * as Library from "./library.js";
