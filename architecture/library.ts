/**
 * Architecture contract: the Library slice, target API. Approved; enforced by
 * architecture/conformance/library.ts and lint.
 *
 * Declares, independently of the implementation:
 *   1. each service's public surface,
 *   2. the services its constructor may require,
 *   3. the persisted state it alone may write, and the entry points that write it.
 *
 * Service surfaces are restated here, never re-exported from the implementation, so a change to
 * the implementation cannot change the contract. Domain data types (LibraryState, Plan, Folder …)
 * are vocabulary and are referenced by name.
 *
 * Markers: APPROVE marks today's boundary, unchanged, for approval as-is. PROPOSED marks a change
 * from today's code. DEBT marks today's code that breaks the contract and is not approved.
 */
import type { Brand, Effect, FileSystem, Option, Path, Scope } from "effect";
import type { Digest } from "effect/crypto";
import type { LibraryState } from "../packages/skit/src/library/library-state.js";
import type {
  Approval,
  Intent as ExistingIntent,
} from "../packages/skit/src/library/library-plan.js";
import type {
  ContentStageError,
  RemoteSyncPlan,
  SetupError,
  SetupResult,
  SetupStopReason,
  StagedContent,
  TargetApplyError,
  TargetOutcome,
  TargetPlan,
  TargetPlanError,
} from "./library-results.js";
import type { InvalidLibraryState, LibraryBusy } from "../packages/skit/src/failures.js";
import type {
  AuthoredImport,
  EditImport,
  ImportAuthoredCollectionError,
  ImportCollectionError,
  ImportEditError,
  ImportedCollection,
  ImportedEdit,
  ImportRequest,
} from "../packages/skit/src/library/import-collection.js";
import type {
  LibraryStateReadError,
  LibraryStateWriteError,
} from "../packages/skit/src/library/store/library-store.js";
import type { LibraryAuditEvent } from "../packages/skit/src/library/audit/audit-log.js";
import type { InventoryScanRoot } from "../packages/skit/src/library/inventory/refresh.js";
import type {
  DeviceSkillSelection,
  SyncAncestry,
} from "../packages/skit/src/library/library-state.js";
import type {
  LibraryManifest,
  SnapshotArchive,
} from "../packages/skit/src/library/library-contracts.js";
import type {
  Backup,
  Cause,
  Changed,
  Destination,
  Duplicate,
  Folder,
  Installed,
  Warning,
} from "../packages/skit/src/library/installed-skills.js";
import type { StagedInstalledSkill } from "../packages/skit/src/install/files.js";
import type { Invocation } from "../packages/skit/src/library/enabled-plan.js";
import type {
  CollectionId,
  InstalledSkillId,
  MachineId,
  SkillId,
  SkillVersionId,
} from "../packages/skit/src/library/entity-ids.js";
import type { OwnershipMarker } from "../packages/skit/src/contracts.js";
import type {
  HarnessName,
  Hash,
  InstallDestination,
  InstallScope,
} from "../packages/skit/src/vocabulary.js";
import type { LinkStat } from "../packages/skit/src/platform/link-stat.js";
import type { SourceProcess } from "../packages/skit/src/platform/source-process.js";

// ── Library ────────────────────────────────────────────────────────────────────────────────────
// The only writer of the Library: state.json, originals/, variants/, audit.jsonl and removed/.
// Its storage (today's LibraryStore, state-file, writer lock, audit log) is private functions
// inside packages/skit/src/library/store/**, not a service.

/** What one read saw. "Absent" has its own revision, so a first sync can plan from it. */
export type Snapshot =
  | { readonly _tag: "Absent"; readonly revision: Revision }
  | { readonly _tag: "Present"; readonly revision: Revision; readonly state: LibraryState };
/** Covers presence, state and any unfinished operation recorded in state.json. */
export type Revision = Brand.Branded<string, "Revision">;
/** One recorded operation. Today the recovery directory's basename (setup-operation.ts:316). */
export type OperationId = Brand.Branded<string, "OperationId">;

// ── Filesystem evidence (core vocabulary) ───────────────────────────────────────────────────────
// What a plan saw at a path, so apply and resume can tell "as recorded" from "changed". Today
// split across ApprovedSymlink / SetupApprovedCopy (setup-decisions.ts:21-35) and the recovery
// move record (recovery-moves.ts:24-42), checked at recovery-moves.ts:267-303.

/** A file's identity: exact device and inode (recovery-moves.ts:24-26 saves them as text). */
export interface FileIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface FolderEvidence extends FileIdentity {
  readonly _tag: "Directory"; // recovery-moves.ts:31, checked :280
  /** The physical parent, re-resolved before each move (recovery-moves.ts:41, :273-279). */
  readonly parent: FileIdentity;
  readonly contentHash: Hash; // recovery-moves.ts:39, fingerprint checked :283
  readonly treeHash: Hash; // currentHash, recovery-moves.ts:35, :287; SetupApprovedCopy.currentHash setup-decisions.ts:32
  readonly marker: Option.Option<string>; // approvedMarker .skit-ownership.json, recovery-moves.ts:40, :288-301
}

export interface LinkEvidence extends FileIdentity {
  readonly _tag: "SymbolicLink"; // recovery-moves.ts:31
  readonly parent: FileIdentity; // recovery-moves.ts:41
  readonly linkTarget: string; // setup-decisions.ts:24, recovery-moves.ts:34
  readonly canonicalPath: string; // setup-decisions.ts:23
  /** The link's own fingerprint; its target's bytes are not touched (recovery-moves.ts:39, :92-96). */
  readonly contentHash: Hash;
}

/** Recorded "nothing here" (the before of a created folder, the after of a moved one). */
export interface AbsentEvidence {
  readonly _tag: "Absent";
  readonly path: string;
  readonly parent: FileIdentity;
}

/** A retained Collection Version in originals/: Import's only folder effect, additive. */
export interface RetainedEvidence {
  readonly _tag: "Retained";
  readonly hash: Hash;
}

export type PathEvidence = FolderEvidence | LinkEvidence | AbsentEvidence;
export type StepEvidence = PathEvidence | RetainedEvidence;

// ── Manage selections ───────────────────────────────────────────────────────────────────────────

/** Duplicate policy, exactly SetupDuplicateAction (setup-decisions.ts:12-17). */
export type DuplicatePolicy =
  | "keep-both"
  | "preserve-duplicates"
  | "retire-aliases"
  | "retain-only";

/** Common to both modes. Core values, not CLI selections (SetupCopySelection, setup-decisions.ts:156-163). */
interface ManageSelectionBase {
  readonly name: string;
  readonly source: FolderEvidence; // sourcePath, hashed before install (manage-existing.ts:355-363)
  readonly duplicates: Option.Option<DuplicatePolicy>; // optionalKey, setup-decisions.ts:159
  readonly approvedSymlinks: readonly LinkEvidence[]; // ApprovedSymlink, setup-decisions.ts:21-28
  readonly approvedCopies: readonly FolderEvidence[]; // SetupApprovedCopy, setup-decisions.ts:30-35
}

/** Bind to a Library match. ManageRequest "existing", manage-existing.ts:266; setup-manage.ts:76-86. */
export interface ManageExistingSelection extends ManageSelectionBase {
  readonly mode: "existing";
  readonly subjectId: string; // candidate.subjectId, setup-manage.ts:84
  readonly currentHash: Hash; // setup-manage.ts:78-79
}

/**
 * Where a "new" copy's files come from. Standalone plans carry their own import (the import runs
 * inside apply, manage-existing.ts:383-403); setup refers to an earlier Import step instead.
 */
export type ManageNewSource =
  | { readonly _tag: "Import"; readonly request: ImportRequest } // manage-existing.ts:400 importSource(plan.sourcePath)
  | { readonly _tag: "Collection"; readonly collectionId: CollectionId }; // already imported: manage-existing.ts:403 subjectId
export type ManageStepSource = ManageNewSource | { readonly _tag: "Step"; readonly step: number }; // index of an Import step earlier in the same setup

/** Retain and take ownership. ManageRequest "retain", manage-existing.ts:267-281; setup-manage.ts:88-119. */
export interface ManageNewSelection<Source = ManageNewSource> extends ManageSelectionBase {
  readonly mode: "new";
  readonly importFrom: Source;
  readonly currentHash: Option.Option<Hash>; // may be undefined, manage-existing.ts:270; setup-manage.ts:97
  /** Equal-byte copies managed in place (manage-existing.ts:274-279, :384-385; setup-manage.ts:98-111). */
  readonly equalCopies: readonly FolderEvidence[];
  /** Absent for repository-owned copies and non-destinations (setup-manage.ts:112-119): retain only. */
  readonly ownership: Option.Option<{
    readonly harnesses: readonly HarnessName[]; // setup-manage.ts:116
    readonly machineId: Option.Option<MachineId>; // setup-manage.ts:117; required if a target is adoptable (manage-existing.ts:390-397)
  }>;
}

export type ManageIntent =
  | {
      readonly _tag: "Manage";
      readonly mode: "existing";
      readonly selections: readonly ManageExistingSelection[];
    }
  | {
      readonly _tag: "Manage";
      readonly mode: "new";
      readonly selections: readonly ManageNewSelection[];
    }; // NEW: manage-existing.ts:408

// ── Intents ─────────────────────────────────────────────────────────────────────────────────────

/** Every change, as one value. EXISTS: today's four. NEW: today's bypassing writers, as intents. */
export type Intent =
  | ExistingIntent // EXISTS: Enabled | Remove | Update | Uninstall (library-plan.ts:40)
  | { readonly _tag: "Undo"; readonly operationId: OperationId } // NEW: setup-undo.ts:272
  | { readonly _tag: "Restore"; readonly operationId: OperationId } // NEW: recovery-moves.ts; revalidates saved folders (:557-585)
  | {
      // NEW: security/review.ts:146
      readonly _tag: "AcceptFinding";
      readonly query: string;
      readonly fingerprint: Hash;
      readonly principal: string;
      readonly rationale: string;
      readonly expiresAt: Option.Option<string>;
    }
  | { readonly _tag: "RefreshInventory"; readonly roots: readonly InventoryScanRoot[] } // NEW: inventory/refresh.ts:233
  | {
      // NEW: local half of sync. Planned BEFORE the remote write (library-sync.ts:285-317) and
      // applied exactly as planned after it succeeds. Remote merge/CAS/transport stay in sync.
      readonly _tag: "Sync";
      readonly deviceSelection: Option.Option<DeviceSkillSelection>; // library-sync.ts:125-132,232-238; pending origin kept
      readonly pendingOrigin: Option.Option<string>;
      /** The ancestry this device previously accepted (library-sync.ts:155); absent with no remote yet. Not post-CAS ancestry. */
      readonly acceptedBase: Option.Option<SyncAncestry>;
      /** The remote write sync will attempt, if any: origin and library it targets. None = zero-remote device-selection path (library-sync.ts:228-240). */
      readonly remote: Option.Option<{
        readonly origin: string;
        readonly libraryId: Option.Option<string>;
      }>;
      /** From Library.content.stage on the desired manifest (replaces archives/manifest; library-sync.ts:292). */
      readonly staged: StagedContent;
    }
  | ManageIntent;

/** Which apply a plan needs. Sync plans that expect a remote write are applied only with its receipt. */
export type ApplyRequest =
  | {
      // Every plan except a remote Sync, including the zero-remote LocalSyncPlan. Cannot carry a receipt.
      readonly _tag: "Apply";
      readonly plan: Exclude<TargetPlan, RemoteSyncPlan>;
      readonly receipt?: never;
    }
  | {
      readonly _tag: "ApplySynced";
      readonly plan: RemoteSyncPlan;
      readonly receipt: RemoteReceipt;
    };

/**
 * What the remote write returned (library-sync.ts:304-309 api.write; :316 ancestryAt(saved, desired)).
 * Apply refuses with StalePlan unless origin, libraryId (when the plan names one) and manifestDigest
 * equal the plan's SyncRemote "Expected". Its ancestry is the post-CAS ancestry apply saves;
 * the plan's acceptedBase is only the ancestry it planned from.
 */
export interface RemoteReceipt {
  readonly origin: string;
  readonly libraryId: string; // library-sync.ts:160
  readonly manifestDigest: Hash; // digest of `desired` as written (library-sync.ts:309)
  readonly revisionId: string; // the written revision, library-sync.ts:161
  readonly ancestry: SyncAncestry; // ancestryAt(saved, desired), library-sync.ts:157-165, :316
}

// ── Setup ───────────────────────────────────────────────────────────────────────────────────────

/** A reviewed copy change, frozen at review. Core form of InstalledSkillChange (setup-contract.ts:215-239). */
export interface ReviewedInstalledSkillChange {
  readonly installedSkillId: Option.Option<InstalledSkillId>;
  readonly skillId: SkillId;
  readonly name: string;
  readonly path: string;
  readonly destination: InstallDestination;
  readonly baselineHash: Option.Option<Hash>;
  readonly currentHash: Option.Option<Hash>;
  readonly desiredHash: Option.Option<Hash>;
  readonly desiredVersionId: Option.Option<SkillVersionId>;
  readonly evidence: Hash; // setup-contract.ts:229; compared by canonical JSON at apply (setup-apply.ts:78-89)
  readonly status:
    | "unchanged"
    | "incoming-update"
    | "local-only"
    | "competing"
    | "protected"
    | "native-delete"
    | "uninstall"
    | "install";
  readonly metadataChanged: boolean;
}

/** SetupVersionChoice, setup-contract.ts:14-18; must match an offered alternative (setup-apply.ts:94-103). */
export interface VersionChoice {
  readonly skillId: SkillId;
  readonly version: "retained" | "local";
  readonly path: Option.Option<string>;
}

/**
 * Setup (decided: crash behaviour follows humanlayer/t3code). Setup prepares the whole list of
 * steps as data; Library saves it in state.json before running any step, runs steps in order
 * (removals last), checks each folder is as recorded before moving it, and marks each step done.
 * After a crash the next run finishes steps that are safe to repeat; if anything differs from
 * what was recorded it stops and reports, and the user can undo. Never rolls back on its own.
 * Discovery folders are saved and undone by MachineSettings; the setup command calls both owners.
 */
export type SetupStep =
  | { readonly _tag: "Import"; readonly request: ImportRequest }
  | {
      readonly _tag: "Manage";
      readonly mode: "existing";
      readonly selections: readonly ManageExistingSelection[];
    }
  | {
      readonly _tag: "Manage";
      readonly mode: "new";
      readonly selections: readonly ManageNewSelection<ManageStepSource>[];
    }
  | {
      readonly _tag: "Update";
      readonly changes: readonly ReviewedInstalledSkillChange[]; // approval.changes, setup-apply.ts:76-89
      readonly versionChoices: readonly VersionChoice[]; // setup-apply.ts:94-105, applied :245-251
    }
  | { readonly _tag: "Remove"; readonly folders: readonly (FolderEvidence | LinkEvidence)[] }; // arbitrary reviewed duplicates (recovery-moves.ts:92-101)

/**
 * One step as saved in state.json before any step runs. `before` and `after` are the evidence
 * the step expects at each path it touches. Resume, per path (modelled on recovery-moves.ts:568-585):
 * observed = after → its own completed effect, skip; observed = before → safe to repeat, run;
 * anything else → Stopped (EvidenceDiffers), nothing more runs. Import is additive
 * (import-collection.ts:478-489) and is always safe to repeat.
 */
export interface RecordedSetupStep {
  readonly step: SetupStep;
  readonly before: readonly StepEvidence[];
  readonly after: readonly StepEvidence[];
  readonly status: "Pending" | "Done";
}

// ── History ─────────────────────────────────────────────────────────────────────────────────────

/** Status of one recorded operation (setup, restore, undo). Replaces bare audit events for operations. */
export type OperationStatus =
  | {
      readonly _tag: "Pending";
      readonly operationId: OperationId;
      readonly steps: readonly RecordedSetupStep[];
    } // recorded, not finished
  | { readonly _tag: "Done"; readonly operationId: OperationId }
  | {
      readonly _tag: "Stopped";
      readonly operationId: OperationId;
      readonly reason: SetupStopReason;
    }; // user may undo

export interface History {
  readonly events: readonly LibraryAuditEvent[]; // audit.jsonl, as today
  readonly operations: readonly OperationStatus[]; // PROPOSED: from state.json operation records
}

/** What startup did with operations it found unfinished. Also visible through history. */
export interface StartupRecovery {
  readonly finished: readonly OperationId[]; // only steps safe to repeat were run
  readonly stopped: readonly Extract<OperationStatus, { _tag: "Stopped" }>[];
}

// ── MachineSettings evidence (contract on another owner) ─────────────────────────────────────────
/**
 * CONTRACT for MachineSettings, the owner of discovery folders (app.ts owners). The setup command
 * calls Library.setup and MachineSettings with the same operationId. Before saving settings,
 * MachineSettings durably records its own before / expected-after discovery evidence keyed by that
 * id (today SetupOperation.recordSettings then settingsSaved, setup-operation.ts:318-345; refused
 * when `before` is not what was expected, :322-326). Its undo refuses unless current settings equal
 * expectedAfter. Library never reads or writes this record.
 */
export interface MachineSettingsSetupRecord {
  readonly operationId: OperationId;
  readonly before: DiscoveryEvidence;
  readonly expectedAfter: DiscoveryEvidence;
}
/** SetupDiscoverySettings (cli setup-undo-intent.ts:99-105) plus machineId (setup-operation.ts:311, :331). */
export interface DiscoveryEvidence {
  readonly settings: unknown; // OPEN: SetupDiscoverySettings moves to core with MachineSettings
  readonly machineId: Option.Option<MachineId>;
}

// ── Surface ─────────────────────────────────────────────────────────────────────────────────────

export interface Library {
  /** One read. Never writes. */
  readonly read: Effect.Effect<Snapshot, LibraryStateReadError>;
  /**
   * Plan against what the front end showed. A plan carries baseRevision (state.json) and, when it
   * touches folders, planId (folder evidence). plan._tag equals intent._tag.
   */
  readonly plan: <I extends Intent>(
    intent: I,
    options: { readonly base: Snapshot; readonly approvals?: readonly Approval[] },
  ) => Effect.Effect<Extract<TargetPlan, { readonly _tag: I["_tag"] }>, TargetPlanError>;
  /**
   * Rechecks both state (baseRevision) and filesystem evidence (planId) under the writer, refusing
   * either with StalePlan. Then one atomic state.json write, including this change's record; then
   * folder work, each move rechecked, idempotent by installed-skill id; then the record is marked
   * done. One history event.
   */
  readonly apply: (request: ApplyRequest) => Effect.Effect<TargetOutcome, TargetApplyError>;
  /**
   * Additive: stores a Source's files as a new Collection Version. It touches no skill folders
   * and needs no base revision: it applies to the latest state under the writer, retains prior
   * versions, and may change the selected version (import-collection.ts:478-489). Inside setup it
   * runs as an Import step.
   */
  readonly import: {
    readonly collection: (
      request: ImportRequest,
    ) => Effect.Effect<ImportedCollection, ImportCollectionError>;
    readonly authored: (
      request: AuthoredImport,
    ) => Effect.Effect<ImportedCollection, ImportAuthoredCollectionError>;
    readonly edit: (request: EditImport) => Effect.Effect<ImportedEdit, ImportEditError>;
  };
  /**
   * NEW: replaces beginSetupOperation and setup-apply's LibraryStore substitution. Failures before
   * the steps are saved are SetupError (nothing written). After, every failure is a Stopped result
   * with its operationId.
   */
  readonly setup: (
    steps: readonly SetupStep[],
    options: { readonly base: Snapshot },
  ) => Effect.Effect<SetupResult, SetupError>;
  /**
   * NEW: retained skill bytes for sync. Replaces callers reading originalsPath and the exported
   * prepareRestore (library-sync.ts:104-107, library-sync-snapshots.ts:15-57).
   */
  readonly content: {
    readonly inspect: (
      snapshot: Snapshot,
    ) => Effect.Effect<
      { readonly _tag: "Intact" } | { readonly _tag: "Changed"; readonly hash: Hash },
      LibraryStateReadError
    >;
    readonly pack: (
      snapshot: Snapshot,
    ) => Effect.Effect<readonly SnapshotArchive[], LibraryStateReadError>;
    /**
     * Before the remote write: retain everything `target` needs from local archives, originals/
     * and `download`. Additive only; existing originals are immutable. Missing content is
     * reported in StagedContent.missing (library-sync-snapshots.ts:30-57, library-sync.ts:292).
     * Sync keeps transport: it supplies `download` over its own API.
     */
    readonly stage: <E, R>(
      target: LibraryManifest,
      source: {
        readonly localArchives: readonly SnapshotArchive[];
        readonly download?: (digest: Hash) => Effect.Effect<SnapshotArchive, E, R>; // library-restore.ts:332-333
        readonly registry: { readonly origin: string; readonly token: Option.Option<string> }; // library-sync-snapshots.ts:53-54
      },
    ) => Effect.Effect<StagedContent, ContentStageError | E, R>;
  };
  /** NEW: replaces the LibraryAuditLog service. Includes pending and stopped operations. */
  readonly history: Effect.Effect<History, LibraryStateReadError>;
  /** What startup recovery did when the layer was built. */
  readonly startup: StartupRecovery;
}

/**
 * How the one constructor routes installed copies. FROM CODE: today's localLibrary (None),
 * recordedLibrary (Recorded) and the CLI-configured InstalledSkills (Configured).
 */
export type Routing =
  | { readonly _tag: "None" } // imports: fail rather than guess destinations
  | { readonly _tag: "Recorded" } // where this device already has copies
  | {
      readonly _tag: "Configured";
      readonly home: string;
      readonly configHome: string;
      readonly overrides: unknown;
    }; // FROM CODE: cli/install/installed-skills.ts:27-31; OPEN: overrides type

/**
 * Library.layer({ home, routing }). Under the home lock it migrates state.json once, then runs
 * startup recovery: each Pending operation finishes the steps safe to repeat, otherwise it is
 * marked Stopped and reported in Library.startup and history. Stopped operations are not layer
 * errors.
 * DECIDED (Tim, 2026-11-03): a stopped setup does not block other Library changes. Library reports
 * it; resume/undo recheck every folder against the recorded evidence and stop if anything changed
 * (t3code EffectOutbox.ts#L492-L519 parks and continues; humanlayer setup.machine.ts#L45-L70).
 */
export interface LibraryConfig {
  readonly home: string;
  readonly routing: Routing;
}

/**
 * Library.layer's error. Migration failure is InvalidLibraryState (state-file.ts:89-100); LibraryBusy
 * when the home lock is held; writes of the migrated state or recovery marks are LibraryStateWriteError.
 */
export type LibraryLayerError =
  | InvalidLibraryState
  | LibraryBusy
  | LibraryStateReadError
  | LibraryStateWriteError;

/** What Library.layer may require. Its methods require nothing. */
export type LibraryRequires =
  | FileSystem.FileSystem
  | Path.Path
  | LinkStat
  | SourceProcess
  | Digest.Digest; // TreeHasher becomes a plain function over Digest (service rule)

// ── InstalledSkills ────────────────────────────────────────────────────────────────────────────
// APPROVE: today's surface, packages/skit/src/library/installed-skills.ts. Facts about skill
// folders, and folder operations that do only what Library decided.
export declare namespace InstalledSkills {
  /** Changes nothing on disk. Anyone may hold these. */
  interface Facts {
    readonly active: Effect.Effect<readonly InstallDestination[], Error>;
    readonly destinations: (scope: InstallScope) => Effect.Effect<readonly Destination[], Error>;
    readonly identify: (
      path: string,
    ) => Effect.Effect<{ readonly key: string; readonly canonicalPath: string }, Error>;
    readonly inspect: (path: string) => Effect.Effect<Folder, Error>;
    readonly hash: (path: string) => Effect.Effect<Hash, Error>;
    readonly check: (folders: readonly Folder[]) => Effect.Effect<void, Changed | Error>;
    readonly build: (
      installedSkill: {
        readonly skillId: SkillId;
        readonly skillVersionId: SkillVersionId;
        readonly destination: InstallDestination;
        readonly root: string;
        readonly invocation: Invocation;
      },
      state: LibraryState,
      originalsPath: string,
    ) => Effect.Effect<StagedInstalledSkill, Error, Scope.Scope>;
    readonly duplicates: {
      readonly scan: (
        scope: InstallScope,
        names: readonly string[],
      ) => Effect.Effect<
        {
          readonly copies: readonly Duplicate[];
          readonly warnings: readonly Warning[];
          readonly roots: readonly string[];
        },
        Error
      >;
    };
  }
  /** Change skill folders. Only Library may call these. */
  interface Operations {
    readonly prepare: (roots: readonly string[]) => Effect.Effect<void, Error>;
    readonly install: (
      staged: StagedInstalledSkill,
      marker: OwnershipMarker,
      recheck: Folder,
    ) => Effect.Effect<Installed, Error>;
    readonly manage: (
      staged: StagedInstalledSkill,
      marker: OwnershipMarker,
      recheck: Folder,
      verification: string,
    ) => Effect.Effect<Installed, Error>;
    readonly backUp: (path: string, into: string) => Effect.Effect<void, Error>;
    readonly uninstall: (
      root: string,
      path: string,
      installedSkillId: InstalledSkillId,
    ) => Effect.Effect<Backup, Error>;
  }
  /** `scan` and `check` change nothing; `keep` and `discard` are operations: Library only. */
  interface Backups {
    readonly backups: {
      readonly scan: (
        root: string,
        installedSkillId: InstalledSkillId,
      ) => Effect.Effect<readonly Backup[], Error>;
      readonly check: (
        backup: Backup,
        state: LibraryState,
        originalsPath: string,
        installedSkillId: InstalledSkillId,
      ) => Effect.Effect<boolean, Error>;
      readonly keep: (backup: Backup) => Effect.Effect<void, Error>;
      readonly discard: (backup: Backup) => Effect.Effect<void, Error>;
    };
  }
  /** Today's union is named `Error` in code, which shadows Effect's Error module; renamed here. */
  type Error = Cause;
  type Interface = Facts & Operations & Backups;
  /** Stand-in for the service tag; the checker binds it to the real one. */
  interface Service {
    readonly _contract: "skit/library/InstalledSkills";
  }
  /** APPROVE: what InstalledSkills.make may require. Routing is a constructor argument. */
  type Requires = FileSystem.FileSystem | Path.Path | LinkStat | SourceProcess | Digest.Digest;
}

// Write authority, removals and debt for this slice live in app.ts (owners.Library, owners.InstalledSkills).
