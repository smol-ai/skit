import { Revision } from "./snapshot.js";
import { Schema } from "effect";
import * as InstalledSkills from "./installed-skills.js";
import type { LibraryStateReadError, LibraryStateWriteError } from "./store/library-store.js";
import { InstalledSkill } from "./device-state.js";
import { LibraryState } from "./library-state.js";
import { Intent as EnabledIntent, Invocation, type InvalidIntent } from "./enabled-plan.js";
import type { InstalledSkillInvalid } from "./installation/install-enabled.js";
import type { CollectionRemovalMissing } from "./installation/remove.js";
import { CollectionId, InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import { ManageApproval } from "../installed-skills/files.js";
import { OwnershipMarker } from "../installed-skills/ownership-marker.js";
import { Hash } from "../shared/hash.js";
import { InstallDestination } from "../installed-skills/destination.js";
import { InstallScope } from "./scope.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import type { UninstallConflict } from "../installed-skills/failures.js";

// ── Intents ──────────────────────────────────────────────────────────────────────────────────────
// Each intent says how the Library should change. Which Installed Skills to install or uninstall is
// never part of an intent: plan works it out from the Library the intent leaves.

/** Change what is enabled. */
export const Enabled = Schema.TaggedStruct("Enabled", {
  changes: Schema.NonEmptyArray(EnabledIntent),
});
export type Enabled = typeof Enabled.Type;
/** Remove a Collection with its Skills, imports, enabled entries and installed copies. */
const Remove = Schema.TaggedStruct("Remove", { collectionId: CollectionId });
/** Bring installed copies up to date; omitted skills means all, an empty list means none. */
const Update = Schema.TaggedStruct("Update", { skills: Schema.optional(Schema.Array(SkillId)) });
/**
 * Uninstall these recorded copies ahead of a sync. Their records stay, as pending, unless listed
 * to drop.
 */
const Uninstall = Schema.TaggedStruct("Uninstall", {
  copies: Schema.Array(InstalledSkillId),
  drop: Schema.Array(InstalledSkillId),
});
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
/** The Library moved on since the change was planned; a revision check names both revisions. */
export class StalePlan
  extends Schema.TaggedError<StalePlan>()("Library.StalePlan", {
    message: Schema.String,
    expected: Schema.optionalKey(Schema.String.pipe(Schema.brand("Revision"))),
    actual: Schema.optionalKey(Schema.String.pipe(Schema.brand("Revision"))),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
  readonly remediation = "Preview the change again.";
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
    "Remove the redundant agent location, keep the Skill in the Library without enabling it, or explicitly use --allow-duplicate.";
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
    "Inspect these destinations and keep foreign or modified content before retrying.";
  get message() {
    return `Selected destinations have not converged: ${this.paths.join(", ")}`;
  }
}

// ── Plan and outcome ─────────────────────────────────────────────────────────────────────────────
import { EnabledChange } from "./enabled-change.js";
export { EnabledChange } from "./enabled-change.js";

/**
 * The Installed Skill the next Library has at one folder, and the Library's record there. A new
 * Installed Skill gets its id when apply installs it, so planning twice plans the same change.
 */
const installedSkillFields = {
  skillId: SkillId,
  skillVersionId: SkillVersionId,
  destination: InstallDestination,
  root: Schema.String,
  path: Schema.String,
  /**
   * The Library's record of this folder, when it has one: its id is this Installed Skill's, and
   * its hash is what SKIT last wrote, so it shows an edit and names the recovery backups of that
   * write. It never takes the new hash.
   */
  recorded: Schema.optionalKey(InstalledSkill),
};
/**
 * What happens at one skill folder. A change where the next Library installs a Skill names that
 * Installed Skill; one where nothing installs any more names only the record.
 */
export const InstalledSkillChange = Schema.Union([
  /** Nothing is there yet. Its bytes are built at apply, once the root exists. */
  Schema.TaggedStruct("Install", { ...installedSkillFields, invocation: Invocation }),
  /** SKIT's unedited folder, or an edit the user approved replacing, goes to recovery for `hash`. */
  Schema.TaggedStruct("Update", { ...installedSkillFields, invocation: Invocation, hash: Hash }),
  /**
   * SKIT's marker goes on a folder that already holds exactly `hash`. `marker`: SKIT's own folder,
   * where only the Version changed; `manage`: a folder SKIT did not write; `replacement`: an edit
   * the user approved keeping.
   */
  Schema.TaggedStruct("Manage", {
    ...installedSkillFields,
    invocation: Invocation,
    hash: Hash,
    verification: Schema.Literals(["replacement", "manage", "marker"]),
  }),
  /** The folder already is `hash`, under SKIT's marker. */
  Schema.TaggedStruct("Unchanged", { ...installedSkillFields, hash: Hash }),
  /** The user deleted it; it stays deleted. */
  Schema.TaggedStruct("KeepDeleted", { ...installedSkillFields, recorded: InstalledSkill }),
  /**
   * The folder holds `currentHash`, which SKIT would replace with `hash`; it is left, and recorded
   * as conflicted against `expectedHash`. `edited`: SKIT wrote it and it was changed since.
   */
  Schema.TaggedStruct("Conflict", {
    ...installedSkillFields,
    hash: Hash,
    currentHash: Hash,
    expectedHash: Hash,
    edited: Schema.Boolean,
  }),
  /** Nothing installs here any more, but the folder was edited where agents do not read it: it is left, and recorded as conflicted. */
  Schema.TaggedStruct("Conflict", { recorded: InstalledSkill, currentHash: Hash }),
  /** The folder is someone else's in itself: it and its record are left exactly as they are. */
  Schema.TaggedStruct("Protected", { ...installedSkillFields, reason: InstalledSkills.Protection }),
  Schema.TaggedStruct("Protected", {
    recorded: InstalledSkill,
    reason: InstalledSkills.Protection,
  }),
  /** The folder there cannot be read as skill content; apply fails on it. */
  Schema.TaggedStruct("Unreadable", { ...installedSkillFields, reason: Schema.String }),
  /** Nothing installs here any more: SKIT's folder goes to recovery. */
  Schema.TaggedStruct("Uninstall", { recorded: InstalledSkill }),
  /** Nothing installs here any more, and the folder is gone or was never SKIT's: only the record goes. */
  Schema.TaggedStruct("Forget", { recorded: InstalledSkill }),
  /** Nothing installs here any more, but it was edited where agents read it: apply refuses. */
  Schema.TaggedStruct("Refuse", { recorded: InstalledSkill, detail: Schema.String }),
]);
export type InstalledSkillChange = typeof InstalledSkillChange.Type;

export const Route = Schema.Struct({
  scope: InstallScope,
  destinations: Schema.Array(InstalledSkills.Destination),
});
export type Route = typeof Route.Type;

/**
 * Plain data. Nothing in it is trusted at apply: apply plans again from the loaded Library, and
 * refuses a different revision, different changes or different folders.
 */
const planFields = {
  baseRevision: Revision,
  approvals: Schema.Array(Approval),
  routes: Schema.Array(Route),
  /** Every folder the changes were decided on, and every original they are built from. */
  folders: Schema.Array(InstalledSkills.Folder),
  /** The Library the intent leaves, before apply records its Installed Skills. */
  next: LibraryState,
  changes: Schema.Array(Schema.Union([EnabledChange, InstalledSkillChange])),
};
/** The top-level tag and intent always name the same operation. */
export const Plan = Schema.TaggedUnion({
  Enabled: { ...planFields, intent: Enabled },
  Remove: { ...planFields, intent: Remove },
  Update: { ...planFields, intent: Update },
  Uninstall: { ...planFields, intent: Uninstall },
});
export type Plan = typeof Plan.Type;

/** The final state of one Installed Skill apply touched, as the Library recorded it. */
export type InstalledSkillResult =
  | {
      readonly _tag: "Installed" | "Unchanged" | "Conflicted" | "Suppressed";
      readonly copy: InstalledSkill;
    }
  | { readonly _tag: "Uninstalled"; readonly copy: InstalledSkill }
  /** Moved to recovery with no verified successor; recorded as pending. */
  | { readonly _tag: "Pending"; readonly copy: InstalledSkill }
  | { readonly _tag: "Failed"; readonly path: string; readonly cause: ApplyError };

export interface AppliedChange {
  readonly change: EnabledChange;
  readonly intent: "saved" | "unchanged";
  readonly revision: string;
  readonly installedSkills: readonly InstalledSkill[];
  readonly copies: readonly InstalledSkillResult[];
  readonly unresolved: readonly string[];
}
export type Outcome =
  | {
      readonly _tag: "Applied";
      readonly results: readonly AppliedChange[];
      /** Every Installed Skill the plan touched, as the Library recorded it. */
      readonly copies: readonly InstalledSkillResult[];
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
