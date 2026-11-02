import { Schema } from "effect";
import { InstalledSkills } from "./installed-skills.js";
import type { LibraryStateReadError, LibraryStateWriteError } from "./store/library-store.js";
import { InvocationPolicies, type InstalledSkill } from "./library-state.js";
import { Intent as EnabledIntent, Invocation, type InvalidIntent } from "./enabled-plan.js";
import { Enabled as EnabledItem } from "./library-contracts.js";
import type { InstalledSkillInvalid } from "./installation/install-enabled.js";
import type { CollectionRemovalMissing } from "./installation/remove.js";
import { CollectionId, InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import { ManageApproval } from "../install/files.js";
import { OwnershipMarker } from "../contracts.js";
import { Hash, InstallDestination, InstallScope } from "../vocabulary.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import type { UninstallConflict } from "../failures.js";

// ── Intents ──────────────────────────────────────────────────────────────────────────────────────
// Each intent says how the Library should change. Which copies to install or uninstall is never
// part of an intent: plan works it out from the Library the intent leaves.

/** Change what is enabled. */
export const Enabled = Schema.TaggedStruct("Enabled", {
  changes: Schema.NonEmptyArray(EnabledIntent),
});
export type Enabled = typeof Enabled.Type;
/** Remove a Collection with its Skills, imports, enabled entries and installed copies. */
export const Remove = Schema.TaggedStruct("Remove", { collectionId: CollectionId });
export type Remove = typeof Remove.Type;
/** Change nothing; bring every installed copy on this device up to date. */
export const Update = Schema.TaggedStruct("Update", {});
export type Update = typeof Update.Type;
/**
 * Uninstall these recorded copies ahead of a sync. Their records stay, as pending, unless listed
 * to drop.
 */
export const Uninstall = Schema.TaggedStruct("Uninstall", {
  copies: Schema.Array(InstalledSkillId),
  drop: Schema.Array(InstalledSkillId),
});
export type Uninstall = typeof Uninstall.Type;
export const Intent = Schema.Union([Enabled, Remove, Update, Uninstall]);
export type Intent = typeof Intent.Type;

/** What the user approved beyond the default safety rules, as previewed. */
export const Approval = Schema.Union([
  /** Take over this folder, which holds exactly SKIT's bytes. */
  Schema.TaggedStruct("Manage", { manage: ManageApproval }),
  /** The user's edited copy becomes the selected Version. */
  Schema.TaggedStruct("AcceptEdit", {
    installedSkillId: InstalledSkillId,
    currentHash: Hash,
    marker: OwnershipMarker,
  }),
  /** Put back this copy, which the user deleted. */
  Schema.TaggedStruct("Restore", { installedSkillId: InstalledSkillId }),
  /** The user's edited copy, as previewed, goes to recovery and the selected Version replaces it. */
  Schema.TaggedStruct("ReplaceEdit", { installedSkillId: InstalledSkillId, currentHash: Hash }),
]);
export type Approval = typeof Approval.Type;

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────
export class StalePlan
  extends Schema.TaggedError<StalePlan>()("Library.StalePlan", { message: Schema.String })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
  readonly remediation = "Preview the Binding change again.";
}

/** Enabling would replace the user's own link where SKIT writes the copy; keeping both is impossible. */
export class InstalledSkillWouldReplaceLink
  extends Schema.TaggedError<InstalledSkillWouldReplaceLink>()("InstalledSkillWouldReplaceLink", {
    links: Schema.Array(Schema.String),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
  readonly remediation =
    "Remove the link and enable again, or run `skit setup` and choose `--duplicates retire-aliases` to back it up with a move record.";
  get message() {
    return `Enabling would replace the link at ${this.links.join(", ")} with SKIT's copy, so both cannot be kept`;
  }
}

/** Policy: Library refuses a duplicate; InstalledSkills only reports that it is there. */
export class InstalledSkillWouldDuplicate
  extends Schema.TaggedError<InstalledSkillWouldDuplicate>()("InstalledSkillWouldDuplicate", {
    duplicates: Schema.Array(InstalledSkills.Duplicate),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
  readonly remediation =
    "Remove the redundant agent location, retain without enabling, or explicitly use --allow-duplicate.";
  get message() {
    return `Enabling would create duplicate skills: ${this.duplicates.flatMap((item) => item.aliases.map((alias) => `${item.name} (${item.harness}): ${alias.path}${alias.via === "symlink" ? ` -> ${item.canonicalPath} (symlink${alias.linkPath !== alias.path ? ` at ${alias.linkPath} -> ${alias.linkTarget}` : ""})` : ""}`)).join("; ")}`;
  }
}

export class DestinationsIncomplete
  extends Schema.TaggedError<DestinationsIncomplete>()("Library.DestinationsIncomplete", {
    paths: Schema.Array(Schema.String),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
  readonly remediation =
    "Inspect these destinations and preserve foreign or modified content before retrying.";
  get message() {
    return `Selected destinations have not converged: ${this.paths.join(", ")}`;
  }
}

// ── Plan and outcome ─────────────────────────────────────────────────────────────────────────────
/** One enabled change at one scope, with what a review of it shows. */
export const BindingChange = Schema.Struct({
  _tag: Schema.Literals(["Enable", "Disable"]),
  subject_id: Schema.Union([SkillId, CollectionId]),
  skills: Schema.Array(Schema.String),
  scope: InstallScope,
  action: Schema.Literals(["enable", "disable"]),
  invocation: Schema.optionalKey(Invocation),
  changed: Schema.Boolean,
  enabled: Schema.Array(EnabledItem),
  invocation_policies: Schema.optionalKey(InvocationPolicies),
  repair: Schema.optionalKey(Schema.Boolean),
  duplicates: Schema.optionalKey(Schema.Array(InstalledSkills.Duplicate)),
  warnings: Schema.optionalKey(Schema.Array(InstalledSkills.Warning)),
  unmanaged_destinations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ destination: InstallDestination, path: Schema.String })),
  ),
});
export type BindingChange = typeof BindingChange.Type;

/** What every change to one skill folder shows. */
const CopyFields = {
  skillId: SkillId,
  destination: InstallDestination,
  path: Schema.String,
  /** The Version the copy should hold; for a copy nothing wants, the one recorded. */
  skillVersionId: SkillVersionId,
  /** The Library's record of this copy, when it has one. */
  recorded: Schema.optionalKey(Schema.Struct({ installedSkillId: InstalledSkillId, hash: Hash })),
  /** What the folder holds now, when it is there and readable. */
  currentHash: Schema.optionalKey(Hash),
  /** What SKIT would write there, when plan built it. */
  wantedHash: Schema.optionalKey(Hash),
  /** The folder as plan inspected it, including what its hash leaves out. */
  evidence: Schema.String,
};
/** What happens to one skill folder, with what a review of it shows. */
export const CopyChange = Schema.Union([
  /** Nothing is there yet. */
  Schema.TaggedStruct("Install", CopyFields),
  /** SKIT's unedited copy of another Version or rendering goes to recovery. */
  Schema.TaggedStruct("Update", CopyFields),
  /**
   * SKIT's marker goes on a folder that already holds exactly the copy's bytes. `marker`: SKIT's
   * own copy, where only the Version changed.
   */
  Schema.TaggedStruct("Manage", {
    ...CopyFields,
    verification: Schema.Literals(["replacement", "adoption", "marker"]),
  }),
  Schema.TaggedStruct("Unchanged", CopyFields),
  /** The user deleted it; it stays deleted. */
  Schema.TaggedStruct("KeepDeleted", CopyFields),
  /** The folder holds what SKIT did not write; it is left, and recorded as conflicted. */
  Schema.TaggedStruct("Conflict", { ...CopyFields, edited: Schema.Boolean, currentHash: Hash }),
  /** The folder there cannot be read as skill content; apply fails on it. */
  Schema.TaggedStruct("Unreadable", { ...CopyFields, reason: Schema.String }),
  /** Nothing wants it: SKIT's copy goes to recovery. */
  Schema.TaggedStruct("Uninstall", CopyFields),
  /** Nothing wants it, and the folder is gone or was never SKIT's: only the record goes. */
  Schema.TaggedStruct("Forget", CopyFields),
  /** Nothing wants it, but it was edited where agents read it: apply refuses. */
  Schema.TaggedStruct("Refuse", { ...CopyFields, detail: Schema.String }),
  /** The folder is someone else's in itself: it and its record are left exactly as they are. */
  Schema.TaggedStruct("Protected", { ...CopyFields, reason: InstalledSkills.Protection }),
]);
export type CopyChange = typeof CopyChange.Type;
export const RemoveChange = Schema.TaggedStruct("Remove", {
  collectionId: CollectionId,
  skillIds: Schema.Array(SkillId),
});
export type RemoveChange = typeof RemoveChange.Type;
export const Change = Schema.Union([BindingChange, CopyChange, RemoveChange]);
export type Change = typeof Change.Type;

export const Route = Schema.Struct({
  scope: InstallScope,
  destinations: Schema.Array(InstalledSkills.Destination),
});
export type Route = typeof Route.Type;

/**
 * Plain data. Nothing in it is trusted at apply: apply plans again from the loaded Library, and
 * refuses a different revision, different changes or different folders.
 */
export const Plan = Schema.Struct({
  baseRevision: Schema.String,
  intent: Intent,
  approvals: Schema.Array(Approval),
  routes: Schema.Array(Route),
  folders: Schema.Array(InstalledSkills.Observed),
  changes: Schema.Array(Change),
});
export type Plan = typeof Plan.Type;

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
