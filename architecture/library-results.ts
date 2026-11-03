/**
 * RESOLUTIONS of this file's OPEN items, following decisions already made (decisions.md D1, D4,
 * service rule). Anything not listed here stays OPEN. The declarations below follow them.
 * 1. Restore records its operation in state.json before moving folders (crash rule), so it does
 *    write state.json under the new model.
 * 2. Undo covers Library and folders; discovery folders are undone by DeviceSettings, called by
 *    the setup command (decided). UndoChange has no settingsChanged; that evidence is
 *    DeviceSettings' own (library.ts DeviceSettingsSetupRecord).
 * 3. planId stays as folder-evidence digest alongside baseRevision: revision covers state.json,
 *    planId covers the folders on disk. Apply rechecks both, and refuses with StalePlan.
 * 4. One stale error: Library's StalePlan (library-plan.ts:61-62). The CLI's PlanIsStale goes.
 * 5. AcceptFinding: acceptedAt is stamped at apply (the moment recorded), so it is in the result,
 *    not the preview; expiry is checked at plan for the preview and again at apply.
 * 6. Sync: plan the local change before the remote write; apply takes the remote result
 *    (RemoteReceipt: revision, post-CAS ancestry) as input, so nothing unknown is guessed at plan
 *    time (library.ts ApplyRequest).
 * 7. OptionCombinationInvalid is CLI flag validation; it stays with the caller. No Library error.
 * 8. Manage "new": in setup the Import step runs first, so its subject exists when Manage plans;
 *    a standalone Manage "new" carries its own import source (library.ts ManageNewSource).
 * 9. RefreshInventory reports backups promoted to kept in its result.
 * 10. Setup Stopped is new behaviour (decided crash rule); no current code produces it.
 */
/**
 * Approved: per-intent plan previews, outcomes and errors for architecture/library.ts's NEW intents.
 * Types only. Every field cites where today's code produces it. Paths are relative to packages/.
 * `// OPEN:` marks anything no current code settles.
 *
 * Vocabulary from the implementation is declared as `Ref<"where it is defined">`; each Ref is an
 * `import type` in the real contract. Vocabulary this contract itself declares comes from
 * ./library.js, so the two files share one Intent, evidence and Revision.
 */
import type { FolderEvidence, Intent, LinkEvidence, OperationId, Revision } from "./library.js";

interface Ref<Where extends string> {
  readonly __ref: Where;
}

// ── Referenced vocabulary (would be `import type`) ───────────────────────────────────────────────
type Hash = Ref<"skit/src/vocabulary.ts Hash">;
type LibraryState = Ref<"skit/src/library/library-state.ts:168">;
type InstalledSkill = Ref<"skit/src/library/library-state.ts:92">;
type InstalledSkillId = Ref<"skit/src/library/entity-ids.ts InstalledSkillId">;
type CollectionId = Ref<"skit/src/library/entity-ids.ts:33-36 CollectionId">;
type CollectionVersionId = Ref<"skit/src/library/entity-ids.ts:43-46 CollectionVersionId">;
type SyncAncestry = Ref<"skit/src/library/library-state.ts:102-108">;
type DeviceSkillSelection = Ref<"skit/src/library/library-state.ts:111-119">;
type InventoryScanRoot = Ref<"skit/src/library/inventory/refresh.ts:17-20">;
type InventoryScanIssue = Ref<"skit/src/library/store/state-schema.ts:27">;
type OwnershipIssue = Ref<"skit/src/library/store/state-schema.ts:64">;
type UnmanagedEntry =
  Ref<"LibraryState['unmanaged'][number]; skit/src/library/store/state-schema.ts:66">;
/** SkillAssessmentAcceptance (state-schema.ts:28-37) minus acceptedAt (:35), which apply stamps. */
type PlannedAcceptance =
  Ref<"Omit<SkillAssessmentAcceptance, 'acceptedAt'>, skit/src/library/store/state-schema.ts:28-37">;
type SkillAssessmentAcceptance = Ref<"skit/src/library/store/state-schema.ts:28-38">;
type SkillSecurityReview = Ref<"skit/src/contracts.ts:256">;
type SyncConflictDetail = Ref<"cli/src/workflows/library/library-sync-contract.ts:8">;
type SetEnabledResult = Ref<"cli/src/workflows/library/set-enabled-contract.ts:62">;
type InstalledSkillChangeResult = Ref<"cli/src/workflows/library/setup-contract.ts:240-255">;
type ImportedCollection = Ref<"skit/src/library/import-collection.ts:77">;
type Backup = Ref<"skit/src/library/installed-skills.ts Backup">;
type ExistingPlan = Ref<"Plan, skit/src/library/library-plan.ts:219-230">;
type ExistingOutcome = Ref<"Outcome, skit/src/library/library-plan.ts:251-263">;
type ExistingPlanError = Ref<"PlanError, skit/src/library/library-plan.ts:265-271">; // includes StalePlan
type ExistingApplyError = Ref<"ApplyError, skit/src/library/library-plan.ts:272-278">;
type ExistingIntentTag = "Enabled" | "Remove" | "Update" | "Uninstall"; // library-plan.ts:40
type IntentOf<Tag extends Intent["_tag"]> = Extract<Intent, { readonly _tag: Tag }>;

// Errors that exist today (Data/Schema tagged errors), referenced by name.
type PlatformError = Ref<"effect PlatformError">;
type LibraryStateReadError = Ref<"skit/src/library/store/library-store.ts:17">;
type LibraryStateWriteError = Ref<"skit/src/library/store/library-store.ts:18-22">; // includes LibraryChanged
type LibraryChanged = Ref<"skit/src/failures.ts:607">;
type StalePlan = Ref<"skit/src/library/library-plan.ts:61-62">; // replaces cli/src/library/failures.ts:11 PlanIsStale
type RecoveryInvalid = Ref<"cli/src/library-application/recovery-evidence.ts:6-7">;
type RestoreInvalid = Ref<"skit/src/library/library-restore.ts:28">;
type ContentAddressCollision = Ref<"skit/src/failures.ts:335">;
type AcceptanceIncomplete = Ref<"skit/src/failures.ts:457-460">;
type SecurityFindingAbsent = Ref<"skit/src/failures.ts:442-445">;
type UnknownInstalledSkill = Ref<"skit/src/failures.ts:349-352">;
type TreeError = Ref<"skit/src/shared/tree-error.ts:56">;
type SyncLocalChanged = Ref<"cli/src/workflows/library/library-sync.ts:60-70">;
type ManageInvalid = Ref<"cli/src/workflows/library/manage-existing.ts:250-254">;
type SetupManageSelectionInvalid = Ref<"cli/src/workflows/library/setup-manage.ts:9-25">;
type SetEnabledIncomplete = Ref<"cli/src/library-application/set-enabled.ts:41-42">;
type ChangeChoiceRequired = Ref<"cli/src/workflows/library/setup-installed-skills.ts:21">;

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────
// Source: cli/src/library-application/setup-undo.ts (+ setup-undo-files.ts).

/** One folder action undo would take. setup-undo-files.ts:126-131, pushed at :231, :253, :323, :345. */
export interface UndoFileAction {
  readonly path: string;
  readonly kind: "release-ownership" | "restore" | "remove-created";
  // Preview today shows only { path, kind } (setup-undo.ts:206). source/transfer are apply-internal
  // (setup-undo-files.ts:128-129); kept private.
}

/** setup-undo.ts:207-219: a Collection whose source import undo returns to an earlier snapshot. */
export interface UndoSourceSelection {
  readonly collectionId: CollectionId;
  readonly label: string;
  readonly fromSnapshot: Hash;
  readonly toSnapshot: Hash;
}

/** Preview. setup-undo.ts:196-222 (summary), consumed by handlers/library/setup-undo.ts:55-69. */
export interface UndoChange {
  readonly operationId: OperationId; // setup-undo.ts:198
  /** Folder-evidence digest; apply refuses a different one with StalePlan (setup-undo.ts:181-195, :246). */
  readonly planId: Hash;
  readonly status: "ready" | "conflicted" | "already-undone"; // setup-undo.ts:200-204
  readonly conflicts: readonly string[]; // setup-undo.ts:104-170, emptied when done (:205)
  readonly files: readonly UndoFileAction[]; // setup-undo.ts:206
  readonly sourceSelections: readonly UndoSourceSelection[]; // setup-undo.ts:207-219
  readonly intentChanged: boolean; // setup-undo.ts:220
  // settingsChanged (setup-undo.ts:221, :273-278) is not here: DeviceSettings undoes discovery
  // from its own record keyed by the same operationId (resolution 2).
  /** The Library undo leaves. setup-undo.ts:171-180; saved at :272. */
  readonly next: LibraryState;
}

/** Outcome. setup-undo.ts:247 (already undone) and :293-297; consumed by handlers/library/setup-undo.ts:100-125. */
export type UndoResult =
  | { readonly _tag: "AlreadyUndone"; readonly change: UndoChange } // setup-undo.ts:247
  | {
      readonly _tag: "Undone"; // setup-undo.ts:295 status "undone"
      readonly change: UndoChange;
      /** Recovery operation holding copies undo moved aside. setup-undo.ts:296; handler :107-123. */
      readonly backupId: OperationId;
    };

/** setup-undo.ts:246 stale; :249, :260, :286 RecoveryInvalid; :272 save; readUndo reads (:57-103). */
export type UndoError =
  | StalePlan
  | RecoveryInvalid
  | LibraryStateReadError
  | LibraryStateWriteError
  | PlatformError;
// OPEN: inspectSetupOperation / prepareSetupSourceUndo error channels not traced.

// ── Restore ─────────────────────────────────────────────────────────────────────────────────────
// Source: cli/src/library-application/recovery-moves.ts, cli/src/handlers/library/recovery.ts.
// Resolution 1: apply's one atomic state.json write is the operation record itself; today the
// renames run under withLibraryWriterLock only (recovery-moves.ts:557-591).

/** One saved entry. RecoveryFact, recovery-moves.ts:76-83; status :492-500, reason :501-511. */
export interface RecoveryEntry {
  readonly name: string;
  readonly path: string; // original path
  readonly recoveryPath: string;
  readonly type: "Directory" | "SymbolicLink";
  readonly status: "saved" | "at-original" | "missing" | "conflict";
  readonly reason: string;
}

/** Preview. RecoveryInspection, recovery-moves.ts:84-90, :534; consumed at handlers/library/recovery.ts:92-105. */
export interface RestoreChange {
  readonly operationId: OperationId;
  readonly directory: string;
  /** Folder-evidence digest; apply refuses another with StalePlan, rechecked after every move (recovery-moves.ts:568-585). */
  readonly planId: Hash;
  /** Only "saved" entries are moved (recovery-moves.ts:571); the handler offers apply only if one exists (recovery.ts:100). */
  readonly entries: readonly RecoveryEntry[];
  readonly legacy: boolean; // recovery-moves.ts:89
}

/**
 * Outcome. apply returns the re-inspection (recovery-moves.ts:588); on failure the handler
 * re-inspects (recovery.ts:120-123) and derives restored | partial | conflicted (:126-139).
 */
export interface RestoreResult {
  readonly after: RestoreChange; // recovery-moves.ts:588
  readonly phase: "restored" | "partial" | "conflicted"; // recovery.ts:133-139
}

/** recovery-moves.ts:569, :575, :585 stale; RecoveryInvalid from readRecoveryOperation (:336-449); :578 rename; record write (resolution 1). */
export type RestoreError =
  | StalePlan
  | RecoveryInvalid
  | PlatformError
  | LibraryStateReadError
  | LibraryStateWriteError;

// ── AcceptFinding ───────────────────────────────────────────────────────────────────────────────
// Source: skit/src/library/security/review.ts:101-147, cli/src/library/security.ts.

/** Preview: the one acceptance apply appends, without acceptedAt (resolution 5). review.ts:132-145. */
export interface AcceptFindingChange {
  /** fingerprint, artifactContentHash, skill_version_id, context "project", principal/rationale trimmed, expiresAt? */
  readonly acceptance: PlannedAcceptance; // review.ts:132-141
}

/** Outcome: the acceptance as saved, and the re-evaluated review. review.ts:147; rendered by handlers/security/accept.ts:102. */
export interface AcceptFindingResult {
  /** acceptedAt read from Clock at apply (review.ts:112); expiry rechecked against it (:125). */
  readonly acceptance: SkillAssessmentAcceptance;
  readonly review: SkillSecurityReview;
}

/** review.ts:114, :124, :126 AcceptanceIncomplete; :131 SecurityFindingAbsent; :49 UnknownInstalledSkill; :62 read; :146 save. */
export type AcceptFindingError =
  | AcceptanceIncomplete
  | SecurityFindingAbsent
  | UnknownInstalledSkill
  | PlatformError
  | LibraryStateWriteError;

// ── RefreshInventory ────────────────────────────────────────────────────────────────────────────
// Source: skit/src/library/inventory/refresh.ts, cli/src/handlers/library/inventory.ts.
// Today scan and save are one step (refresh.ts:232-233); there is no preview. The preview below
// is what scanInventory computes before the save.

/** Preview. refresh.ts:226-233. */
export interface RefreshInventoryChange {
  readonly roots: readonly InventoryScanRoot[]; // deduplicated, refresh.ts:231 (:21-32)
  /** Installed skills re-observed: installed | conflicted | pending | suppressed. refresh.ts:39-67. */
  readonly installedSkills: readonly InstalledSkill[];
  /** Replaced within the scanned roots, kept outside them. refresh.ts:78-81, :209-219. */
  readonly unmanaged: readonly UnmanagedEntry[];
  readonly ownershipIssues: readonly OwnershipIssue[]; // refresh.ts:82-84, :184-208
  readonly scanIssues: readonly InventoryScanIssue[]; // refresh.ts:69-71, :97-163, :221-222
  readonly next: LibraryState; // refresh.ts:232, saved at :233
}

/**
 * Outcome. refresh.ts:246 returns { state, roots }; the CLI narrows observations to the roots
 * (handlers/library/inventory.ts:38-53) and doctor reports on it (:112-113).
 */
export interface RefreshInventoryResult {
  readonly roots: readonly InventoryScanRoot[]; // refresh.ts:246
  readonly state: LibraryState; // refresh.ts:246
  /** Pending backups promoted to kept after a verified install (refresh.ts:236-245); not reported today (resolution 9). */
  readonly keptBackups: readonly Backup[];
}

/** refresh.ts:101-163 (non-NotFound/PermissionDenied PlatformError), :60/:182 hashing, :233 save, :243-244 rename. */
export type RefreshInventoryError = PlatformError | TreeError | LibraryStateWriteError;
// OPEN: deterministicTreeHash's error channel assumed TreeError (skit/src/shared/tree-error.ts); not traced.

// ── Content staging (before the remote write) ──────────────────────────────────────────────────
// Source: cli/src/workflows/library/library-sync-snapshots.ts:30-57 (planCollectionVersions +
// prepareRestore), called at library-sync.ts:292. Library owns it; sync keeps transport and
// passes only a download function.

/** What Library.content.stage prepared for one target manifest. */
export interface StagedContent {
  /** Digest of the normalised target manifest; Sync plans and receipts are bound to it. */
  readonly manifestDigest: Hash;
  /** Already in originals/, verified (collection-version-plan.ts:30-31). */
  readonly reusable: readonly Hash[];
  /** Downloaded and retained in originals/ by this call (collection-version-plan.ts:32, library-restore.ts:328-334). */
  readonly retained: readonly Hash[];
  /**
   * Required but neither local nor downloadable (collection-version-plan.ts:33 reacquire;
   * library-restore.ts "not downloaded" RestoreInvalid). Reported, not thrown; plan(Sync)
   * refuses a non-empty list.
   */
  readonly missing: readonly CollectionVersionId[];
  /** The restored portable state blended in at save (library-restore.ts:391-407). */
  readonly state: LibraryState;
}

/** library-restore.ts RestoreInvalid; :59 collision; originals writes. Download failures are the caller's E. */
export type ContentStageError =
  | RestoreInvalid
  | ContentAddressCollision
  | PlatformError
  | TreeError;

// ── Sync (local half) ───────────────────────────────────────────────────────────────────────────
// Source: cli/src/workflows/library/library-sync.ts, library-sync-installed-skills.ts.
// Remote read/merge/upload/CAS/transport stay in sync; these types cover only what saves locally.

/** Preview of local copy changes. SyncInstalledSkillPlan, library-sync-installed-skills.ts:134-140. */
export interface SyncInstalledSkillsChange {
  readonly projections: readonly InstalledSkill[]; // installed_skills sync records (:413-430)
  readonly retire: readonly InstalledSkillId[]; // uninstalled before the save (:371)
  readonly remove: readonly InstalledSkillId[]; // records dropped (:371 `drop`)
  /** Deferred device conflicts when a device selection is in use (:155, :167, :415). */
  readonly issues: readonly SyncConflictDetail[];
}

/**
 * Which remote write this plan expects. "None": the zero-remote device-selection path
 * (library-sync.ts:228-240), applied without a receipt. "Expected": apply requires a
 * RemoteReceipt with this exact origin, library and manifest digest.
 */
export type SyncRemote =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Expected";
      readonly origin: string; // library-sync.ts:157-165 ancestryAt origin
      readonly libraryId: string | undefined; // absent on a first push; the receipt names it (library-sync.ts:305-309)
      readonly manifestDigest: Hash; // = StagedContent.manifestDigest of `desired`, library-sync.ts:304-309
    };

/** Preview. Planned before the remote write (library-sync.ts:210-226, :259-282). */
export interface SyncChange<Remote extends SyncRemote = SyncRemote> {
  /** Device state after merge and selection, library-sync.ts:180-186. */
  readonly device: LibraryState;
  readonly deviceSelection: DeviceSkillSelection | undefined; // library-sync.ts:180-185
  readonly installedSkills: SyncInstalledSkillsChange | undefined; // absent when no local Library (:-installed-skills.ts:401-410)
  /** library-sync.ts:275-280; shown in merge/adoption preview. */
  readonly collectionsToRemove: number;
  /** Selected skills/collections no longer in the Library. library-sync.ts:194-197, reported at :348-349. */
  readonly missingSelection: readonly string[];
  /** Destination collisions deferred under a device selection. library-sync.ts:198-209, :350. */
  readonly collisions: readonly SyncConflictDetail[];
  /** Clean sync only anchors ancestry/selection (library-sync.ts:228-240). */
  readonly clean: boolean;
  /**
   * The ancestry this device previously accepted and planned from (state sync_ancestry,
   * library-sync.ts:155). Not the ancestry apply saves: that is RemoteReceipt.ancestry, known only
   * after the CAS (library-sync.ts:316 `ancestryAt(saved, desired)`).
   */
  readonly acceptedBase: SyncAncestry | undefined;
  readonly remote: Remote;
  /** Content staged by Library.content.stage before planning (replaces transfer.restore, library-sync.ts:292). */
  readonly staged: StagedContent;
}

/** Outcome. library-sync.ts:244-255 (clean) and :327-337 (pushed/pulled/merged). Local fields only. */
export interface SyncResult {
  readonly installed: number; // library-sync.ts:253, :334 (from Update outcome, -installed-skills.ts:353)
  /** Retired before the save plus uninstalled by the follow-up Update. library-sync.ts:313-318, :335. */
  readonly uninstalled: number;
  /** Non-empty → status "enablement_incomplete" (library-sync.ts:245-250, :328-331, :348-407). */
  readonly enablementIssues: readonly string[];
  /** The ancestry saved: the receipt's, or unchanged on the "None" path. */
  readonly ancestry: SyncAncestry | undefined;
}

/**
 * library-sync.ts:239, :300, :317 SyncLocalChanged; -installed-skills.ts:421 LibraryChanged;
 * :370-376 nested Uninstall plan/apply; :350 nested Update; a receipt not matching the plan's
 * SyncRemote is StalePlan. Device-selection flag validation (library-sync.ts:189-193,
 * OptionCombinationInvalid) stays with the caller (resolution 7).
 */
export type SyncError =
  | SyncLocalChanged
  | LibraryChanged
  | StalePlan
  | RestoreInvalid // staged.missing non-empty at plan
  | LibraryStateReadError
  | LibraryStateWriteError
  | ExistingApplyError;
// Conflicts (library-sync.ts:179, :208-209, :224-225) and statuses base_mismatch / adoption_required /
// resolution_invalid are returned as values before the local plan exists; they stay in sync.

// ── Manage ──────────────────────────────────────────────────────────────────────────────────────
// Source: cli/src/workflows/library/manage-existing.ts (+ setup-manage.ts, its only caller).
// Today Manage is an Enabled plan with a Manage approval (manage-existing.ts:485-522) wrapped by
// import (:366-370, :410-417) and duplicate backup (:425-431, :541).

/** Duplicates moved to recovery after install. prepareRecoveryMoves, recovery-moves.ts:187-190. */
export interface ManageBackupPreview {
  readonly recoveryDirectory: string; // recovery-moves.ts:189
  readonly entries: readonly {
    readonly name: string;
    readonly path: string;
    readonly type: "Directory" | "SymbolicLink";
  }[]; // :190
}

/** Preview of one selection. */
export interface ManageSelectionChange {
  readonly name: string; // checkManageSelection input, manage-existing.ts:286
  readonly sourcePath: string;
  readonly mode: "existing" | "new"; // ManageRequest kind "existing" | "retain", manage-existing.ts:266-281 (setup-manage.ts:46)
  readonly currentHash: Hash; // manage-existing.ts:355-363
  readonly equalCopies: readonly FolderEvidence[]; // manage-existing.ts:384-385, setup-manage.ts:98-111
  readonly duplicateAction: "keep-both" | "preserve-duplicates" | "retire-aliases" | "retain-only"; // setup-decisions.ts:12-17
  readonly approvedSymlinks: readonly LinkEvidence[]; // manage-existing.ts:328-332, :558-597
  readonly approvedCopies: readonly FolderEvidence[]; // manage-existing.ts:308-317
  /** Undefined when nothing is installed (retain-only), manage-existing.ts:350-353. */
  readonly enable: ExistingPlan | undefined; // manage-existing.ts:487-522
  readonly backup: ManageBackupPreview | undefined; // manage-existing.ts:364-370, :425-449, :624-640
  /**
   * "new" copies are imported first (manage-existing.ts:383-403). Standalone, the plan carries
   * the import source and `enable` is computed at apply under the writer; in setup the Import step
   * has already run (resolution 8).
   */
}

/** Preview. */
export interface ManageChange {
  readonly mode: "existing" | "new"; // setup-manage.ts:46
  /** Folder-evidence digest over every selection's evidence; apply refuses another with StalePlan. */
  readonly planId: Hash;
  readonly selections: readonly ManageSelectionChange[];
}

/** Outcome. setup-manage.ts:126; per copy manage-existing.ts:542-553. */
export interface ManageResult {
  readonly results: readonly SetEnabledResult[]; // manage-existing.ts:540; setup-apply.ts:201-214 discards them today
  /** "new" selections: the Collection each import created (manage-existing.ts:400-403). */
  readonly imported: readonly ImportedCollection[];
  readonly recoveryDirectories: readonly string[]; // manage-existing.ts:544-547
  /** Incomplete destinations (:527-533) and duplicates left in place (:548-551, :660-683). */
  readonly warnings: readonly { readonly name: string; readonly message: string }[];
}

/** manage-existing.ts:362, :378, :386, :564-595 stale; :373, :394, :399, :402 ManageInvalid; :534 SetEnabledIncomplete. */
export type ManageError =
  | StalePlan
  | ManageInvalid
  | SetupManageSelectionInvalid // setup-manage.ts:51-70, :128-132 (wraps ManageInvalid)
  | SetEnabledIncomplete
  | RecoveryInvalid // prepareRecoveryMoves, recovery-moves.ts:119-169
  | ExistingApplyError
  | PlatformError
  | TreeError;
// OPEN: importSource's error channel (manage-existing.ts:371, :410) not traced.

// ── Setup ───────────────────────────────────────────────────────────────────────────────────────
// Source: cli/src/workflows/library/setup-apply.ts:70-285. The one SetupResult; library.ts uses it.

/** One finished step, by step tag. */
export type SetupStepResult =
  | { readonly _tag: "Import"; readonly imported: ImportedCollection } // import-collection.ts:77, setup-apply.ts imports stage
  | { readonly _tag: "Manage"; readonly result: ManageResult } // setup-apply.ts:201-214
  | { readonly _tag: "Update"; readonly changes: readonly InstalledSkillChangeResult[] } // setup-apply.ts:226-251
  | {
      readonly _tag: "Remove";
      readonly recoveryDirectory: string;
      readonly removed: readonly string[];
    }; // setup-apply.ts:268-275

/** Why a persisted setup stopped. Every reason carries the step index it stopped at. */
export type SetupStopReason =
  | {
      /** A folder differs from both the step's recorded before and after evidence (recovery-moves.ts:568-585). */
      readonly _tag: "EvidenceDiffers";
      readonly step: number;
      readonly path: string;
      readonly expected: {
        readonly before: FolderEvidence | LinkEvidence | undefined;
        readonly after: FolderEvidence | LinkEvidence | undefined;
      };
    }
  | {
      /** state.json moved under the operation (setup-apply.ts:220, :265 LibraryChanged). */
      readonly _tag: "LibraryChanged";
      readonly step: number;
      readonly revision: Revision;
    }
  | {
      /** The step failed after the operation was persisted (ManageError, PlatformError, write errors). */
      readonly _tag: "StepFailed";
      readonly step: number;
      readonly error: ManageError | PlatformError | TreeError | LibraryStateWriteError;
    };

export type SetupResult =
  | {
      readonly _tag: "Done";
      readonly operationId: OperationId; // setup-apply.ts:282
      readonly steps: readonly SetupStepResult[]; // one per SetupStep, same order
      readonly warnings: readonly { readonly name: string; readonly message: string }[]; // :152, :201, :213
      readonly recoveryDirectories: readonly string[]; // :153, :202, :214
      // scan (setup-apply.ts:278) is the setup command's own input echoed back; it stays with the caller.
    }
  | {
      /** NEW (resolution 10). The user can undo by operationId; Library never rolls back on its own. */
      readonly _tag: "Stopped";
      readonly operationId: OperationId;
      readonly completed: readonly SetupStepResult[];
      readonly reason: SetupStopReason;
    };

/**
 * Failures BEFORE the operation is persisted: nothing was written, no operationId exists.
 * Once state.json holds the operation, every failure is returned as SetupResult Stopped (with
 * operationId), never through this channel; interruption leaves it Pending for startup.
 */
export type SetupError =
  | StalePlan // setup-apply.ts:84, :93, :103 (reviewed changes / version choices no longer match); base revision moved
  | ChangeChoiceRequired // :105
  | SetupManageSelectionInvalid // selections checked before any step (setup-manage.ts:48-56)
  | LibraryStateReadError
  | LibraryStateWriteError; // the write that persists the operation

// ── Target plan / outcome / errors ──────────────────────────────────────────────────────────────

interface PlanBase<Tag extends Intent["_tag"], Change> {
  /** Mirrors intent._tag so the plan narrows without nested discrimination. */
  readonly _tag: Tag;
  /** Covers state.json; apply refuses a moved revision with StalePlan. library-plan.ts:221. */
  readonly baseRevision: Revision;
  readonly intent: IntentOf<Tag>;
  /**
   * Changes that touch folders also carry planId (folder evidence). Apply rechecks state
   * (baseRevision) and filesystem evidence (planId) under the writer, and again before each move.
   */
  readonly change: Change;
}

export type ExistingTargetPlan = {
  [Tag in ExistingIntentTag]: ExistingPlan & { readonly _tag: Tag; readonly intent: IntentOf<Tag> };
}[ExistingIntentTag]; // library-plan.ts:219-230, unchanged but for the mirrored _tag

export type LocalSyncPlan = PlanBase<"Sync", SyncChange<Extract<SyncRemote, { _tag: "None" }>>>;
export type RemoteSyncPlan = PlanBase<
  "Sync",
  SyncChange<Extract<SyncRemote, { _tag: "Expected" }>>
>;

export type TargetPlan =
  | ExistingTargetPlan
  | PlanBase<"Undo", UndoChange>
  | PlanBase<"Restore", RestoreChange>
  | PlanBase<"AcceptFinding", AcceptFindingChange>
  | PlanBase<"RefreshInventory", RefreshInventoryChange>
  | LocalSyncPlan
  | RemoteSyncPlan
  | PlanBase<"Manage", ManageChange>;

export type TargetOutcome =
  | (ExistingOutcome & { readonly intent: ExistingIntentTag })
  | { readonly intent: "Undo"; readonly result: UndoResult }
  | { readonly intent: "Restore"; readonly result: RestoreResult }
  | { readonly intent: "AcceptFinding"; readonly result: AcceptFindingResult }
  | { readonly intent: "RefreshInventory"; readonly result: RefreshInventoryResult }
  | { readonly intent: "Sync"; readonly result: SyncResult }
  | { readonly intent: "Manage"; readonly result: ManageResult };
// OPEN: ExistingOutcome already uses `_tag` (Applied | Incomplete), hence `intent` as the discriminant here.

export type TargetPlanError =
  | ExistingPlanError
  | AcceptanceIncomplete
  | SecurityFindingAbsent
  | UnknownInstalledSkill
  | RecoveryInvalid
  | RestoreInvalid
  | ManageInvalid
  | SetupManageSelectionInvalid;

export type TargetApplyError =
  | ExistingApplyError
  | UndoError
  | RestoreError
  | AcceptFindingError
  | RefreshInventoryError
  | SyncError
  | ManageError;
// Apply requests (which plan needs a RemoteReceipt) are declared in library.ts ApplyRequest.
