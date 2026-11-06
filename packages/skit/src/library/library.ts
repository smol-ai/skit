import type { PlatformError } from "effect/PlatformError";
import type { RecoveryInvalid, RecoveryInspection } from "./recovery-facts.js";
import type { LibraryChanged } from "./failures.js";
import type {
  RestoreIntent,
  RestorePlan,
  RestoreOutcome,
  RestorePlanError,
  RestoreApplyError,
} from "./internal/recovery/restore.js";

import {
  type SyncIntent,
  type SyncPlan,
  type SyncOutcome,
  type RemoteSyncPlan,
  type RemoteReceipt,
  type SyncPlanError,
  type SyncApplyError,
} from "./internal/sync/sync.js";
export {
  SyncPlan,
  isRemoteSyncPlan,
  type RemoteSyncPlan,
  type SyncStopped,
} from "./internal/sync/sync.js";
import { makeOwner } from "./internal/runtime.js";
import {
  type ManageIntent,
  type ManagePlan,
  type ManageOutcome,
  type ManagePlanError,
  type ManageApplyError,
} from "./internal/manage/manage.js";
export {
  ManageIntent,
  ManagePlan,
  type ManageStopped,
} from "./internal/manage/manage.js";
import {
  type AcceptFindingIntent,
  type AcceptFindingPlan,
  type AcceptFindingOutcome,
  type AcceptFindingPlanError,
  type AcceptFindingApplyError,
} from "./internal/security/accept.js";
export { AcceptFindingPlan } from "./internal/security/accept.js";
import {
  type RefreshInventoryIntent,
  type RefreshInventoryPlan,
  type RefreshInventoryOutcome,
  type RefreshInventoryPlanError,
  type RefreshInventoryApplyError,
} from "./internal/inventory/refresh.js";
export { RefreshInventoryPlan } from "./internal/inventory/refresh.js";
import {
  type UndoPlanError,
  type UndoApplyError,
} from "./internal/setup/undo.js";
import type {
  UndoIntent,
  UndoPlan,
  UndoResult,
} from "./internal/setup/undo-plan.js";
import { Context, Effect, Layer } from "effect";
import {
  type StagedContent,
  type ContentSource,
  type ContentStageError,
} from "./internal/content/content.js";
import type { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
import type { CollectionVersionPlan } from "./collection-version-plan.js";
import type { Digest } from "effect/crypto";
import * as InstalledSkills from "./installed-skills.js";
import type { InventoryRootOptions } from "./routing/roots.js";
import type { HttpClient } from "effect/http";
import type {
  LibraryLayerError,
  LibraryStateReadError,
} from "./store/library-store.js";
import type {
  OperationStatus as StoredOperationStatus,
  RecordedSetupStep,
  SetupStep,
} from "./store/state-schema.js";
import {
  type LibraryAuditEvent,
  type LibraryAuditInvalid,
} from "./audit/audit-log.js";
import { type Snapshot } from "./snapshot.js";
import {
  type SetupError,
  type SetupResult,
  type StartupRecovery,
} from "./internal/setup/run.js";

import {
  type AuthoredImport,
  type EditImport,
  type ImportAuthoredCollectionError,
  type ImportCollectionError,
  type ImportEditError,
  type ImportedCollection,
  type ImportedEdit,
  type ImportRequest,
} from "./import-collection.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import {
  type ApplyError as ExistingApplyError,
  type Approval,
  type StalePlan,
  type Intent,
  type Outcome as ExistingOutcome,
  type Plan,
  type PlanError as ExistingPlanError,
} from "./library-plan.js";
export {
  Enabled,
  Intent,
  Approval,
  StalePlan,
  type DestinationsIncomplete,
  type InstalledSkillWouldReplaceLink,
  type InstalledSkillWouldDuplicate,
  EnabledChange,
  Plan,
  type InstalledSkillResult,
} from "./library-plan.js";
export { UndoPlan } from "./internal/setup/undo-plan.js";

export { reviewInstalledSkillChanges } from "./installed-skill-review.js";
export {
  InvalidIntent,
  enabledCollections,
  uniqueInstallScopes,
  sameInstallScope,
} from "./enabled-plan.js";
export type { SetupApproval } from "./enabled-plan.js";

export { Revision, type Snapshot } from "./snapshot.js";
export type {
  LibraryLayerError,
  LibraryStateReadError,
} from "./store/library-store.js";
export {
  RestoreInvalid,
  SourceRestoreInvalid,
} from "./internal/content/restore.js";
export type { StagedContent } from "./internal/content/content.js";
export type {
  FolderEvidence,
  LinkEvidence,
  ManageExistingSelection,
  ManageNewSelection,
  ReviewedInstalledSkillChange,
  SetupStep,
  SetupStopReason,
} from "./store/state-schema.js";
/** History reports steps and evidence, without private installed-change checkpoints. */
type ReportedOperation<O> = {
  readonly [
    K in keyof O as K extends "preparation" ? never : K
  ]: K extends "steps" ? readonly Omit<RecordedSetupStep, "applies">[] : O[K];
};
type OperationStatus = ReportedOperation<StoredOperationStatus>;

export interface History {
  readonly events: readonly LibraryAuditEvent[];
  readonly operations: readonly OperationStatus[];
}

/** The operation applied, with its complete or partial result kept intact. */
interface EnabledOutcome {
  readonly _tag: "Enabled";
  readonly result: ExistingOutcome;
}

export interface RemoveOutcome {
  readonly _tag: "Remove";
  readonly result: ExistingOutcome;
}

export interface UpdateOutcome {
  readonly _tag: "Update";
  readonly result: ExistingOutcome;
}
interface UninstallOutcome {
  readonly _tag: "Uninstall";
  readonly result: ExistingOutcome;
}
interface UndoOutcome {
  readonly _tag: "Undo";
  readonly result: UndoResult;
}
export type Outcome =
  | RestoreOutcome
  | SyncOutcome
  | EnabledOutcome
  | RemoveOutcome
  | UpdateOutcome
  | UninstallOutcome
  | UndoOutcome
  | ManageOutcome
  | AcceptFindingOutcome
  | RefreshInventoryOutcome;

/** Every intent uses the same planning entry point and the same reviewed-data boundary. */
export type PlanningIntent =
  | Intent
  | RestoreIntent
  | SyncIntent
  | ManageIntent
  | AcceptFindingIntent
  | RefreshInventoryIntent
  | UndoIntent;
export type ReviewedPlan =
  | Plan
  | RestorePlan
  | SyncPlan
  | ManagePlan
  | AcceptFindingPlan
  | RefreshInventoryPlan
  | UndoPlan;
export type PlanError =
  | ExistingPlanError
  | RestorePlanError
  | SyncPlanError
  | ManagePlanError
  | AcceptFindingPlanError
  | RefreshInventoryPlanError
  | UndoPlanError
  | InstalledSkills.Cause;

export type ApplyRequest =
  | {
      readonly _tag: "Apply";
      readonly plan: Exclude<ReviewedPlan, RemoteSyncPlan>;
      readonly receipt?: never;
    }
  | {
      readonly _tag: "ApplySynced";
      readonly plan: RemoteSyncPlan;
      readonly receipt: RemoteReceipt;
    };
export type ApplyError = Exclude<
  | ExistingApplyError
  | RestoreApplyError
  | SyncApplyError
  | ManageApplyError
  | AcceptFindingApplyError
  | RefreshInventoryApplyError
  | UndoApplyError,
  LibraryChanged
>;

export interface Interface {
  /**
   * One read. Never writes: a legacy state.json was migrated when the layer was built, and a read
   * refuses any state.json that is not the current version.
   */
  readonly read: Effect.Effect<Snapshot, LibraryStateReadError>;
  /**
   * Plan against the Snapshot the front end showed, including whether the Library existed.
   * Captures its state; apply refuses the plan if the Library has changed since.
   */
  readonly plan: <I extends PlanningIntent>(
    intent: I,
    options: {
      readonly base: Snapshot;
      readonly approvals?: readonly Approval[];
    },
  ) => Effect.Effect<
    Extract<ReviewedPlan, { readonly _tag: I["_tag"] }>,
    PlanError
  >;
  readonly apply: <Request extends ApplyRequest>(
    request: Request,
  ) => Effect.Effect<
    Extract<Outcome, { readonly _tag: Request["plan"]["_tag"] }>,
    ApplyError
  >;
  /**
   * Store a Source's files as a Collection Version and save it. Nothing to preview or recheck: it
   * touches no skill folders, and what it imports exists only while the fetched Source does.
   */
  readonly import: {
    readonly collection: (
      request: ImportRequest,
    ) => Effect.Effect<ImportedCollection, ImportCollectionError>;
    readonly authored: (
      request: AuthoredImport,
    ) => Effect.Effect<ImportedCollection, ImportAuthoredCollectionError>;
    /** An edited copy, as a new Version of its Skill. */
    readonly edit: (
      request: EditImport,
    ) => Effect.Effect<ImportedEdit, ImportEditError>;
  };
  /**
   * Save the steps in state.json as one Pending operation, then run them in order, removals last,
   * marking each Done. Failures before the steps are saved are SetupError and write nothing;
   * after, every failure is a Stopped result with its operationId. Never rolls back on its own.
   */
  readonly setup: (
    steps: readonly SetupStep[],
    options: { readonly base: Snapshot },
  ) => Effect.Effect<SetupResult, SetupError>;
  readonly content: {
    /** Read-only availability for a passive sync preview; no paths escape the owner. */
    readonly plan: (
      target: LibraryManifest,
      localArchives: readonly SnapshotArchive[],
    ) => Effect.Effect<CollectionVersionPlan, LibraryStateReadError>;
    readonly inspect: (
      snapshot: Snapshot,
    ) => Effect.Effect<
      | { readonly _tag: "Intact" }
      | {
          readonly _tag: "Changed";
          readonly hash: import("../shared/hash.js").Hash;
        },
      LibraryStateReadError | StalePlan
    >;
    readonly pack: (
      snapshot: Snapshot,
    ) => Effect.Effect<
      readonly SnapshotArchive[],
      LibraryStateReadError | StalePlan
    >;
    readonly stage: <E = never, R = never>(
      target: LibraryManifest,
      source: ContentSource<E, R>,
    ) => Effect.Effect<StagedContent, ContentStageError | E, R>;
  };
  /** Audit events and recorded operations, including Pending and Stopped setup. Never writes. */
  readonly history: Effect.Effect<
    History,
    LibraryStateReadError | LibraryAuditInvalid
  >;
  /** Passive recovery facts; malformed audit history must not hide saved files. */
  readonly recovery: {
    readonly list: Effect.Effect<
      readonly string[],
      PlatformError | RecoveryInvalid
    >;
    readonly inspect: (
      operationId: string,
    ) => Effect.Effect<RecoveryInspection, PlatformError | RecoveryInvalid>;
  };
  /** What startup recovery did when the layer was built. */
  readonly startup: StartupRecovery;
}
export class Service extends Context.Service<Service, Interface>()(
  "skit/library/Library",
) {}

/** Routing is part of constructing this Library, never assembled by an operation's caller. */
export type Routing =
  | { readonly _tag: "None" }
  | { readonly _tag: "Recorded" }
  | ({ readonly _tag: "Configured" } & InventoryRootOptions);

export interface Config {
  readonly home: string;
  readonly routing: Routing;
}

/** One public constructor owns migration, startup recovery, storage and installed-skill routing. */
export const layer = (
  config: Config,
): Layer.Layer<
  Service,
  LibraryLayerError,
  TreeRequirements | Digest.Digest | HttpClient.HttpClient
> => Layer.effect(Service, makeOwner(config));

export type { LibraryStateWriteError } from "./store/library-store.js";

export type { SetupResult } from "./internal/setup/run.js";
