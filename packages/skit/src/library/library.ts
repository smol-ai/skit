import { join } from "node:path";
import {
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  type Scope,
} from "effect";
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
  setEnabledAt,
  pruneEmptyEnabled,
  type LibraryState,
  type InstalledSkill,
  type InstalledSkillSuppressed,
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
} from "./enabled.js";
import { currentSkillVersion, enabledSkillIds, versionBacking } from "./library-contracts.js";
import { collectionVersionPath } from "./collection-version.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
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
  type ManageApproval,
} from "../install/files.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../install/policy.js";
import type { OwnershipMarker } from "../contracts.js";
import type { Hash, InstallDestination, InstallScope } from "../vocabulary.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { canonicalJson } from "../shared/json.js";
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

// ── Intents ──────────────────────────────────────────────────────────────────────────────────────
// Each intent says how the Library should change. Which copies to install or uninstall is never
// part of an intent: plan works it out from the Library the intent leaves.

/** Change what is enabled. */
export interface Enabled {
  readonly _tag: "Enabled";
  readonly changes: readonly [EnabledIntent, ...EnabledIntent[]];
}
/** Remove a Collection with its Skills, imports, enabled entries and installed copies. */
export interface Remove {
  readonly _tag: "Remove";
  readonly collectionId: CollectionId;
}
/** Change nothing; bring every installed copy on this device up to date. */
export interface Update {
  readonly _tag: "Update";
}
/**
 * Uninstall these recorded copies ahead of a sync. Their records stay, as pending, unless listed
 * to drop.
 */
export interface Uninstall {
  readonly _tag: "Uninstall";
  readonly copies: readonly InstalledSkillId[];
  readonly drop: readonly InstalledSkillId[];
}
export type Intent = Enabled | Remove | Update | Uninstall;

/** What the user approved beyond the default safety rules, as previewed. */
export type Approval =
  /** Take over this folder, which holds exactly SKIT's bytes. */
  | { readonly _tag: "Manage"; readonly manage: ManageApproval }
  /** The user's edited copy becomes the selected Version. */
  | {
      readonly _tag: "AcceptEdit";
      readonly installedSkillId: InstalledSkillId;
      readonly currentHash: Hash;
      readonly marker: OwnershipMarker;
    }
  /** Put back this copy, which the user deleted. */
  | { readonly _tag: "Restore"; readonly installedSkillId: InstalledSkillId };

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────
export class StalePlan
  extends Data.TaggedError("Library.SetEnabledStale")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the Binding change again.";
}

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

/** What happens to one skill folder. */
export type CopyChange = {
  readonly skillId: SkillId;
  readonly destination: InstalledSkill["destination"];
  readonly path: string;
} & (
  | /** Nothing is there yet. */ { readonly _tag: "Install" }
  /** SKIT's unedited copy of another Version or rendering goes to recovery. */
  | { readonly _tag: "Update" }
  /** SKIT's marker goes on a folder that already holds exactly the copy's bytes. */
  | { readonly _tag: "Manage" }
  | { readonly _tag: "Unchanged" }
  /** The user deleted it; it stays deleted. */
  | { readonly _tag: "KeepDeleted" }
  /** The folder holds what SKIT did not write; it is left, and recorded as conflicted. */
  | { readonly _tag: "Conflict"; readonly edited: boolean; readonly hash: Hash }
  /** The folder there cannot be read as skill content; apply fails on it. */
  | { readonly _tag: "Unreadable"; readonly reason: string }
  /** Nothing wants it: SKIT's copy goes to recovery. */
  | { readonly _tag: "Uninstall" }
  /** Nothing wants it, and the folder is gone or was never SKIT's: only the record goes. */
  | { readonly _tag: "Forget" }
  /** Nothing wants it, but it was edited where agents read it: apply refuses. */
  | { readonly _tag: "Refuse"; readonly detail: string }
);
export interface RemoveChange {
  readonly _tag: "Remove";
  readonly collectionId: CollectionId;
  readonly skillIds: readonly SkillId[];
}
export type Change = BindingChange | CopyChange | RemoveChange;

export interface Route {
  readonly scope: InstallScope;
  readonly destinations: readonly InstalledSkills.Destination[];
}

/**
 * Plain data. Nothing in it is trusted at apply: apply plans again from the loaded Library, and
 * refuses a different revision, different changes or different folders.
 */
export interface Plan {
  readonly baseRevision: string;
  readonly intent: Intent;
  readonly approvals: readonly Approval[];
  readonly routes: readonly Route[];
  readonly folders: readonly InstalledSkills.Observed[];
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
      readonly reason: "destinations" | "update";
      readonly cause: ApplyError;
    };

export type PlanError =
  | LibraryStateReadError
  | InvalidIntent
  | StalePlan
  | CollectionRemovalMissing
  | InstalledSkillInvalid
  | InstalledSkills.Cause;
export type ApplyError =
  | PlanError
  | LibraryStateWriteError
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
    intent: Intent,
    options: { readonly base: LibraryState; readonly approvals?: readonly Approval[] },
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

/** One copy the next Library should have installed, with what installing it would write. */
interface Wanted {
  readonly copy: InstalledSkills.Copy;
  readonly destination: InstalledSkills.Destination;
  readonly name: string;
  readonly path: string;
  /** The record at this place before, matched by physical root. */
  readonly prior: InstalledSkill | undefined;
  readonly folder: InstalledSkills.Observed;
}

/** One change with what apply needs to carry it out. */
type Step =
  | { readonly _tag: "Install"; readonly change: CopyChange; readonly wanted: Wanted }
  | {
      readonly _tag: "Unreadable";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly reason: string;
    }
  | {
      readonly _tag: "KeepDeleted";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly prior: InstalledSkillSuppressed;
    }
  | {
      readonly _tag: "Update" | "Unchanged";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      /** Built to decide what happens at a folder that is already there. */
      readonly staged: InstalledSkills.Staged;
    }
  | {
      readonly _tag: "Manage";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly staged: InstalledSkills.Staged;
      readonly verification: "replacement" | "adoption" | "marker";
    }
  | {
      readonly _tag: "Conflict";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly staged: InstalledSkills.Staged;
      readonly edited: boolean;
      readonly hash: Hash;
      readonly expectedHash: Hash;
    }
  | {
      readonly _tag: "Uninstall" | "Forget" | "Refuse";
      readonly change: CopyChange;
      readonly copy: InstalledSkill;
    }
  /** An edited copy where agents do not read it: kept, and recorded as conflicted. */
  | {
      readonly _tag: "Keep";
      readonly change: CopyChange;
      readonly copy: InstalledSkill;
      readonly hash: Hash;
    };

/** Everything plan shows and apply carries out. Builds live as long as the Scope. */
interface Work {
  readonly next: LibraryState;
  readonly routes: readonly Route[];
  readonly steps: readonly Step[];
  readonly folders: readonly InstalledSkills.Observed[];
  readonly changes: readonly Change[];
  readonly requests: readonly {
    readonly request: Request;
    readonly change: BindingChange;
    readonly skillIds: readonly SkillId[];
  }[];
}

/** Operations report their cause inside Failed; callers see the cause itself. */
const unwrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, InstalledSkills.Failed> =>
        Predicate.isTagged(error, "Library.InstalledSkillsFailed"),
      (failed) => Effect.fail(failed.cause),
    ),
  );

const markerFor = (copy: InstalledSkills.Copy, hash: Hash): OwnershipMarker => ({
  schemaVersion: 5,
  installed_skill_id: copy.installedSkillId,
  skill_id: copy.skillId,
  skill_version_id: copy.skillVersionId,
  expected_hash: hash,
});

const sameScope = (left: InstallScope, right: InstallScope) =>
  canonicalJson(left) === canonicalJson(right);

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
    const read = yield* unwrap(files.inspect(copy.path));
    if (read.entry._tag === "Absent" || read.entry.facts === null)
      return { _tag: "Absent" as const };
    const { marker } = read.entry.facts;
    const hash = yield* unwrap(files.hash(copy.path));
    return marker.kind !== "valid" ||
      marker.marker.skill_id !== copy.skill_id ||
      marker.marker.installed_skill_id !== copy.installed_skill_id ||
      hash !== marker.marker.expected_hash
      ? { _tag: "Edited" as const, hash, marked: marker.kind !== "absent" }
      : { _tag: "Intact" as const, hash };
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

  /** The approved folder at this path, compared by physical path. */
  const approvedForManage = Effect.fn("Library.approvedForManage")(function* (
    approvals: readonly Approval[],
    path: string,
  ) {
    const target = (yield* unwrap(files.identify(path))).key;
    for (const approval of approvals)
      if (approval._tag === "Manage")
        for (const approved of [approval.manage.path, ...(approval.manage.equalPaths ?? [])])
          if ((yield* unwrap(files.identify(approved))).key === target) return approval.manage;
    return undefined;
  });

  /** What each intent changes in the Library itself, before any copy is considered. */
  const edit = Effect.fn("Library.edit")(function* (base: LibraryState, intent: Intent) {
    switch (intent._tag) {
      case "Update":
      case "Uninstall":
        return { next: base, requests: [] };
      case "Remove": {
        if (!base.collections.some((item) => item.collection_id === intent.collectionId))
          return yield* new CollectionRemovalMissing({ collection_id: intent.collectionId });
        const skills = new Set<string>(
          base.skills
            .filter((skill) => skill.collection_id === intent.collectionId)
            .map((skill) => skill.skill_id),
        );
        const imports = base.imports.filter((item) => item.collection_id !== intent.collectionId);
        const surviving = new Set(imports.map((item) => item.collection_version_id));
        const pruned = removeFromEnabled(base, {
          skills,
          collections: new Set([intent.collectionId]),
        });
        return {
          next: {
            ...pruned,
            collections: pruned.collections.filter(
              (item) => item.collection_id !== intent.collectionId,
            ),
            skills: pruned.skills.filter((skill) => !skills.has(skill.skill_id)),
            imports,
            collection_versions: pruned.collection_versions.filter((version) =>
              surviving.has(version.collection_version_id),
            ),
          },
          requests: [],
        };
      }
      case "Enabled": {
        const requests = (yield* Effect.forEach(intent.changes, (change) =>
          expandIntent(base, change),
        )).flat();
        const edited = yield* Effect.reduce(
          requests,
          (): { next: LibraryState; requests: { request: Request; calculated: Calculated }[] } => ({
            next: base,
            requests: [],
          }),
          (sofar, request) =>
            Effect.map(calculateEnabled(sofar.next, request), (calculated) => ({
              next: calculated.plan.changed
                ? setEnabledAt(sofar.next, request.scope, calculated.plan)
                : sofar.next,
              requests: [...sofar.requests, { request, calculated }],
            })),
        );
        return {
          next: requests.some((request) => !request.enabled)
            ? pruneEmptyEnabled(edited.next)
            : edited.next,
          requests: edited.requests,
        };
      }
    }
  });

  /**
   * Plan one intent: edit the Library, then compare the copies it should have installed with what
   * is recorded and on disk. Builds each wanted copy, so the Scope must outlive any apply.
   */
  const work = Effect.fn("Library.work")(function* (
    base: LibraryState,
    intent: Intent,
    approvals: readonly Approval[],
  ): Effect.fn.Return<Work, PlanError, Scope.Scope> {
    const { next, requests } = yield* edit(base, intent);
    const enabling = requests.filter(({ request }) => request.enabled);
    // Enabling a Skill puts back its deleted copies; otherwise only an approved copy comes back.
    const enabled = new Set<string>(enabling.flatMap(({ calculated }) => calculated.skillIds));
    const restored = new Set<string>(
      approvals.flatMap((approval) =>
        approval._tag === "Restore" ? [approval.installedSkillId] : [],
      ),
    );
    const restore = (copy: InstalledSkills.Copy) =>
      enabled.has(copy.skillId) || restored.has(copy.installedSkillId);
    const accepted = new Map(
      approvals.flatMap((approval) =>
        approval._tag === "AcceptEdit" ? [[approval.installedSkillId, approval] as const] : [],
      ),
    );

    // Where every scope this device uses, or this intent touches, installs.
    const intended = intent._tag === "Uninstall" ? [] : deviceInstallationIntent(next).byScope;
    const scopes = [
      ...intended.map((item) => item.scope),
      ...requests.map(({ request }) => request.scope),
    ].filter((scope, index, all) => all.findIndex((other) => sameScope(scope, other)) === index);
    const routes = yield* Effect.forEach(scopes, (scope) =>
      Effect.map(unwrap(files.destinations(scope)), (destinations): Route => ({
        scope,
        destinations,
      })),
    );
    const active: readonly InstallDestination[] =
      intent._tag === "Uninstall" ? [] : yield* unwrap(files.active);

    // Physical roots, so a configured symlink alias is the same place.
    const keys = new Map<string, string>();
    for (const root of new Set([
      ...routes.flatMap((route) => route.destinations.map((target) => target.root)),
      ...base.installed_skills.map((copy) => copy.root),
    ]))
      keys.set(root, (yield* unwrap(files.identify(root))).key);
    const at = (copy: InstalledSkill, target: InstalledSkills.Destination) =>
      copy.destination === target.destination && keys.get(copy.root) === keys.get(target.root);

    // Every copy the next Library should have installed, built so it can be compared.
    const wanted: Wanted[] = [];
    for (const enabled of intended) {
      const route = routes.find((item) => sameScope(item.scope, enabled.scope));
      for (const target of route?.destinations ?? [])
        for (const skillId of enabledSkillIds(next, enabled.enabled)) {
          const skill = next.skills.find((item) => item.skill_id === skillId);
          const version = skill === undefined ? undefined : currentSkillVersion(next, skill);
          if (
            skill === undefined ||
            version === undefined ||
            versionBacking(next, skill, version) === undefined
          )
            return yield* new InstalledSkillInvalid({
              detail: "An enabled Skill has no selected retained Version",
            });
          const prior = base.installed_skills.find(
            (copy) => copy.skill_id === skill.skill_id && at(copy, target),
          );
          const policy = enabled.invocation_policies?.[skill.skill_id];
          const copy: InstalledSkills.Copy = {
            state: next,
            originalsPath: store.originalsPath,
            installedSkillId: prior?.installed_skill_id ?? makeInstalledSkillId(),
            skillId: skill.skill_id,
            skillVersionId: version.skill_version_id,
            invocationIntent:
              policy === undefined ? declaredInvocationIntent : overrideInvocationIntent(policy),
          };
          const name = yield* installedSkillName(skill.name);
          const path = join(target.root, name);
          wanted.push({
            copy,
            destination: target,
            name,
            path,
            prior,
            folder: yield* unwrap(files.inspect(path)),
          });
        }
    }

    // What happens at each wanted copy's folder.
    const installing: Step[] = [];
    for (const item of wanted) {
      const { copy, path, prior, folder } = item;
      const at = { skillId: copy.skillId, destination: item.destination.destination, path };
      const facts = folder.entry._tag === "Present" ? folder.entry.facts : null;
      if (folder.entry._tag === "Present" && facts === null && folder.entry.kind !== "SymbolicLink")
        return yield* new InstalledSkillInvalid({ detail: `Not a skill folder: ${path}` });
      if (facts === null) {
        // A copy the user deleted stays deleted unless they asked to restore it, or a backup
        // shows SKIT moved it aside. An installed copy whose folder is gone was deleted too.
        if (
          (prior?.status === "suppressed" || prior?.status === "installed") &&
          !restore(copy) &&
          !(yield* displaced(prior))
        ) {
          installing.push({
            _tag: "KeepDeleted",
            change: { ...at, _tag: "KeepDeleted" },
            wanted: item,
            prior:
              prior.status === "suppressed"
                ? prior
                : InstalledSkillStatus.suppressed(
                    prior,
                    new Date(yield* Clock.currentTimeMillis).toISOString(),
                  ),
          });
          continue;
        }
        installing.push({ _tag: "Install", change: { ...at, _tag: "Install" }, wanted: item });
        continue;
      }
      if (typeof facts.hash !== "string") {
        const reason = `${facts.hash.reason}: ${path}`;
        installing.push({
          _tag: "Unreadable",
          change: { ...at, _tag: "Unreadable", reason },
          wanted: item,
          reason,
        });
        continue;
      }
      const staged = yield* unwrap(files.build(copy, item.destination));
      const recorded = prior?.installed_skill_id === copy.installedSkillId ? prior : undefined;
      const approval = accepted.get(copy.installedSkillId);
      const manage = yield* approvedForManage(approvals, path);
      // Decided against the hash an installed copy is verified with; an unreadable folder fails.
      const decided = decide(
        {
          marker: facts.marker,
          hash: facts.hash,
          directory: folder.entry._tag === "Present" && folder.entry.kind === "Directory",
          insideRepository: facts.insideRepository,
          holdsRepositoryFiles: facts.holdsRepositoryFiles,
          approvedForManage: manage !== undefined,
        },
        {
          installedSkillId: copy.installedSkillId,
          skillId: copy.skillId,
          skillVersionId: copy.skillVersionId,
          hash: staged.hash,
          recordedHash: recorded?.expected_hash,
          manage: manage === undefined ? undefined : { hash: manage.currentHash },
          // Enabling may take over a folder that is exactly SKIT's bytes; updating never does.
          manageIdentical: enabling.some(({ request }) =>
            routes.some(
              (route) =>
                sameScope(route.scope, request.scope) &&
                route.destinations.some((target) => target.root === item.destination.root),
            ),
          ),
          replacement:
            approval === undefined
              ? undefined
              : { hash: approval.currentHash, marker: approval.marker },
        },
      );
      if (Result.isFailure(decided))
        return yield* new InstalledSkillInvalid({ detail: `${decided.failure}: ${path}` });
      const decision = decided.success;
      switch (decision._tag) {
        case "KeepSuppressed":
          // decide keeps a copy deleted only when its folder is gone, which is handled above.
          return yield* new InstalledSkillInvalid({
            detail: `Deleted copy still present: ${path}`,
          });
        case "Manage":
          installing.push({
            _tag: "Manage",
            change: { ...at, _tag: "Manage" },
            wanted: item,
            staged,
            verification: decision.verification,
          });
          break;
        case "Conflict":
          installing.push({
            _tag: "Conflict",
            change: { ...at, _tag: "Conflict", edited: decision.edited, hash: decision.hash },
            wanted: item,
            staged,
            edited: decision.edited,
            hash: decision.hash,
            expectedHash: decision.edited ? decision.expectedHash : staged.hash,
          });
          break;
        case "Unchanged":
          installing.push({
            _tag: "Unchanged",
            change: { ...at, _tag: "Unchanged" },
            wanted: item,
            staged,
          });
          break;
        case "Replace":
          installing.push({
            _tag: "Update",
            change: { ...at, _tag: "Update" },
            wanted: item,
            staged,
          });
          break;
        case "Install":
          installing.push({ _tag: "Install", change: { ...at, _tag: "Install" }, wanted: item });
          break;
      }
    }

    // Every recorded copy nothing wants any more.
    const uninstalling: Step[] = [];
    const unwanted =
      intent._tag === "Uninstall"
        ? base.installed_skills.filter((copy) => intent.copies.includes(copy.installed_skill_id))
        : base.installed_skills.filter(
            (copy) =>
              !wanted.some(
                (item) =>
                  item.copy.installedSkillId === copy.installed_skill_id ||
                  (item.copy.skillId === copy.skill_id && at(copy, item.destination)),
              ),
          );
    for (const copy of unwanted) {
      const change = { skillId: copy.skill_id, destination: copy.destination, path: copy.path };
      const owned = yield* ownership(copy);
      if (owned._tag === "Absent") {
        uninstalling.push({ _tag: "Forget", change: { ...change, _tag: "Forget" }, copy });
        continue;
      }
      if (owned._tag === "Intact") {
        uninstalling.push({ _tag: "Uninstall", change: { ...change, _tag: "Uninstall" }, copy });
        continue;
      }
      // A copy still wanted elsewhere at its destination is moving; an edited one is refused.
      const moving = wanted.some(
        (item) =>
          item.copy.skillId === copy.skill_id && item.destination.destination === copy.destination,
      );
      // Otherwise a folder without SKIT's marker was never SKIT's to remove: only its record goes.
      if (!owned.marked && !moving && intent._tag !== "Uninstall") {
        uninstalling.push({ _tag: "Forget", change: { ...change, _tag: "Forget" }, copy });
        continue;
      }
      // An edited copy where agents read it, or of a Skill the Library no longer has, is refused;
      // elsewhere it is kept and reported, so it cannot block every later update.
      if (
        intent._tag === "Uninstall" ||
        moving ||
        !next.skills.some((skill) => skill.skill_id === copy.skill_id) ||
        active.some((destination) => destination === copy.destination)
      ) {
        const detail = `Refusing to remove modified Skill at ${copy.path}`;
        uninstalling.push({ _tag: "Refuse", change: { ...change, _tag: "Refuse", detail }, copy });
        continue;
      }
      uninstalling.push({
        _tag: "Keep",
        change: { ...change, _tag: "Conflict", edited: true, hash: owned.hash },
        copy,
        hash: owned.hash,
      });
    }

    const steps = [...installing, ...uninstalling];
    // The originals each wanted copy is built from: a change to them makes the plan stale.
    const originals = [
      ...new Set(
        wanted.flatMap((item) => {
          const skill = next.skills.find((candidate) => candidate.skill_id === item.copy.skillId);
          const version = skill?.versions.find(
            (candidate) => candidate.skill_version_id === item.copy.skillVersionId,
          );
          const backing =
            skill === undefined || version === undefined
              ? undefined
              : versionBacking(next, skill, version);
          return backing === undefined
            ? []
            : [collectionVersionPath(store.originalsPath, backing.copy.hash)];
        }),
      ),
    ];
    const folders = [
      ...wanted.map((item) => item.folder),
      ...(yield* Effect.forEach(originals, (path) => unwrap(files.inspect(path)))),
      ...(yield* Effect.forEach(
        unwanted.filter((copy) => !wanted.some((item) => item.path === copy.path)),
        (copy) => unwrap(files.inspect(copy.path)),
      )),
    ].sort((left, right) => left.path.localeCompare(right.path));

    // What each enabled change shows: duplicates and unmanaged folders, and whether it repairs.
    const shown: {
      request: Request;
      change: BindingChange;
      skillIds: readonly SkillId[];
    }[] = [];
    for (const { request, calculated } of requests) {
      const route = routes.find((item) => sameScope(item.scope, request.scope));
      const duplicates = yield* unwrap(
        files.duplicates.scan(
          request.scope,
          skillsToCheckForDuplicates(
            base,
            request.scope,
            request.enabled ? calculated.plan.skills : [],
            calculated.newlyEnabledSkills,
          ),
        ),
      );
      const here = steps.filter((step) =>
        route?.destinations.some((target) =>
          "wanted" in step
            ? step.wanted.destination.root === target.root &&
              step.wanted.destination.destination === target.destination
            : at(step.copy, target),
        ),
      );
      const subject = (skillId: string) =>
        (calculated.skillIds as readonly string[]).includes(skillId);
      const unmanaged = request.enabled
        ? wanted.flatMap((item) =>
            subject(item.copy.skillId) &&
            here.some((step) => "wanted" in step && step.wanted === item) &&
            item.folder.entry._tag === "Present" &&
            item.folder.entry.kind !== "SymbolicLink" &&
            item.folder.entry.facts?.marker.kind !== "valid"
              ? [{ destination: item.destination.destination, path: item.path }]
              : [],
          )
        : [];
      const repair =
        !calculated.plan.changed &&
        here.some(
          (step) =>
            step._tag !== "Unchanged" &&
            step._tag !== "KeepDeleted" &&
            (request.enabled ? subject(step.change.skillId) : "copy" in step),
        );
      shown.push({
        request,
        skillIds: calculated.skillIds,
        change: {
          ...calculated.plan,
          _tag: request.enabled ? "Enable" : "Disable",
          ...(repair ? { repair } : {}),
          ...(duplicates.copies.length ? { duplicates: duplicates.copies } : {}),
          ...(duplicates.warnings.length ? { warnings: duplicates.warnings } : {}),
          ...(unmanaged.length ? { unmanaged_destinations: unmanaged } : {}),
        },
      });
    }

    const removal: Change[] =
      intent._tag === "Remove"
        ? [
            {
              _tag: "Remove",
              collectionId: intent.collectionId,
              skillIds: base.skills
                .filter((skill) => skill.collection_id === intent.collectionId)
                .map((skill) => skill.skill_id),
            },
          ]
        : [];
    return {
      next,
      routes,
      steps,
      folders,
      changes: [
        ...shown.map((item) => item.change),
        ...removal,
        ...steps.map((step) => step.change),
      ],
      requests: shown,
    };
  });

  const plan: Interface["plan"] = Effect.fn("Library.plan")(function* (intent, options) {
    const base = structuredClone(options.base);
    const approvals = structuredClone(options.approvals ?? []);
    const reviewed = structuredClone(intent);
    const planned = yield* Effect.scoped(work(base, reviewed, approvals));
    return {
      baseRevision: libraryStateRevision(base),
      intent: reviewed,
      approvals,
      routes: planned.routes,
      folders: planned.folders,
      changes: planned.changes,
    };
  });

  /** Policy: refuse a duplicate the request did not allow, or a link SKIT's copy would replace. */
  const refuseDuplicates = Effect.fn("Library.refuseDuplicates")(function* (
    request: Request,
    change: BindingChange,
    targets: readonly InstalledSkills.Destination[],
  ) {
    if (!request.enabled || change.duplicates === undefined) return;
    if (!request.allowDuplicate) {
      // Setup consent covers only these exact links, while they are still the links reviewed.
      const remaining: InstalledSkills.Duplicate[] = [];
      for (const duplicate of change.duplicates) {
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
    step: Extract<Step, { readonly wanted: Wanted }>,
  ) {
    const { wanted } = step;
    const installedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    if (step._tag === "KeepDeleted")
      return { copy: step.prior, result: { _tag: "Suppressed", copy: step.prior } as const };
    if (step._tag === "Unreadable")
      return yield* new InstalledSkillInvalid({ detail: step.reason });
    // A folder that was not there is built only now, once its root exists.
    const staged =
      step._tag === "Install"
        ? yield* unwrap(files.build(wanted.copy, wanted.destination))
        : step.staged;
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
        return { copy, result: { _tag: "Unchanged", copy } as const };
      }
      case "Conflict": {
        const { hash, edited } = step;
        if (edited)
          yield* unwrap(
            files.backUp(
              wanted.path,
              installedSkillVariantPath(
                store.variantsPath,
                wanted.destination.destination,
                wanted.name,
                hash,
              ),
            ),
          );
        const copy = InstalledSkillStatus.conflicted(row, hash, step.expectedHash);
        return { copy, result: { _tag: "Conflicted", copy } as const };
      }
      case "Manage":
      case "Update":
      case "Install": {
        // Apply created the root since plan read this folder; nothing may have appeared there.
        const folder =
          step._tag === "Install" ? yield* unwrap(files.inspect(wanted.path)) : wanted.folder;
        if (folder.entry._tag !== "Absent" && step._tag === "Install")
          return yield* new StalePlan({
            message: `Installed skill evidence changed at ${wanted.path}`,
          });
        const marker = markerFor(wanted.copy, staged.hash);
        const installed = yield* unwrap(
          step._tag === "Manage"
            ? files.manage(staged, marker, folder, step.verification)
            : files.install(staged, marker, folder),
        );
        const copy = InstalledSkillStatus.installed(row, installed.hash);
        return { copy, result: { _tag: "Installed", copy } as const };
      }
    }
  });

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
      copies: copies.filter(
        (copy) => copy._tag !== "Failed" && skillIds.includes(copy.copy.skill_id),
      ),
      unresolved,
    };
  };

  const apply: Interface["apply"] = Effect.fn("Library.apply")(function* (reviewed) {
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
          if (libraryStateRevision(base) !== input.baseRevision)
            return yield* changedSincePreview();
          const again = yield* work(base, input.intent, input.approvals);
          // A refusal by policy says more than "changed since preview", so it is checked first.
          for (const step of again.steps)
            if (step.change._tag === "Refuse")
              return yield* new UninstallConflict({ detail: step.change.detail });
          for (const { request, change } of again.requests)
            yield* refuseDuplicates(
              request,
              change,
              again.routes.find((route) => sameScope(route.scope, request.scope))?.destinations ??
                [],
            );
          if (
            canonicalJson(again.routes) !== canonicalJson(input.routes) ||
            canonicalJson(again.changes) !== canonicalJson(input.changes)
          )
            return yield* stale("Installed agent targets or paths changed after preview");
          yield* unwrap(files.check(input.folders)).pipe(
            Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
              Effect.fail(stale(error.message)),
            ),
          );

          // Folders exist and are writable before the Library saves what it wants.
          yield* unwrap(
            files.prepare([
              ...new Set(
                again.steps.flatMap((step) =>
                  "wanted" in step && step._tag !== "KeepDeleted"
                    ? [step.wanted.destination.root]
                    : [],
                ),
              ),
            ]),
          );
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
          ) =>
            Effect.all([
              Ref.update(records, (all) =>
                new Map(all).set(copy.installed_skill_id, changes.final),
              ),
              changes.onDisk === undefined
                ? Effect.void
                : Ref.update(onDisk, (all) =>
                    new Map(all).set(copy.installed_skill_id, changes.onDisk!),
                  ),
              changes.result === undefined
                ? Effect.void
                : Ref.update(copies, (all) => [...all, changes.result!]),
            ]);
          const kept = (copy: InstalledSkill) =>
            input.intent._tag === "Uninstall" &&
            !input.intent.drop.includes(copy.installed_skill_id)
              ? copy.status === "suppressed"
                ? copy
                : InstalledSkillStatus.pending(copy)
              : null;

          // Install first; a Skill's old copy is uninstalled only after its new one is installed.
          const run = Effect.gen(function* () {
            const installedAt = new Set<string>();
            for (const step of again.steps) {
              if (!("wanted" in step)) continue;
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
              if ("wanted" in step) continue;
              const { copy } = step;
              // Keep the last working copy where its successor is blocked or locally modified.
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
                  yield* unwrap(files.uninstall(copy.root, copy.path, copy.installed_skill_id));
                  // Moved to recovery: until the Library records why, it is pending, never deleted.
                  yield* record(copy, {
                    final: kept(copy),
                    onDisk:
                      copy.status === "suppressed" ? copy : InstalledSkillStatus.pending(copy),
                    result: { _tag: "Uninstalled", copy },
                  });
                  break;
              }
            }
          });

          /** `onto` with these records changed. */
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
                  !onto.installed_skills.some(
                    (item) => item.installed_skill_id === copy.installed_skill_id,
                  ),
              ),
            ],
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
                finish(
                  change,
                  skillIds,
                  again.routes.find((route) => sameScope(route.scope, request.scope))
                    ?.destinations ?? [],
                  [],
                  saved,
                ),
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
              Effect.map(
                unwrap(files.backups.scan(copy.root, copy.installed_skill_id)),
                (backups) => backups.map((backup) => ({ backup, copy })),
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
                finish(
                  change,
                  skillIds,
                  again.routes.find((route) => sameScope(route.scope, request.scope))
                    ?.destinations ?? [],
                  touched,
                  edited,
                ),
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
            finish(
              change,
              skillIds,
              again.routes.find((route) => sameScope(route.scope, request.scope))?.destinations ??
                [],
              touched,
              saved,
            ),
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
      Effect.provideService(LibraryStore, store),
      Effect.provide(writer),
    );
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
