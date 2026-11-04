import { makeWithRouting, ownerLayer } from "./internal/runtime.js";
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
  ManageChange,
  ManageStopped,
  type ManageResult,
  type ManageOutcome,
  type ManagePlanError,
  type ManageApplyError,
} from "./internal/manage/manage.js";
import {
  type AcceptFindingIntent,
  type AcceptFindingPlan,
  type AcceptFindingOutcome,
  type AcceptFindingPlanError,
  type AcceptFindingApplyError,
} from "./internal/security/accept.js";
export {
  AcceptFindingIntent,
  AcceptFindingPlan,
  AcceptFindingChange,
  type AcceptFindingResult,
  type AcceptFindingOutcome,
  type AcceptFindingPlanError,
  type AcceptFindingApplyError,
} from "./internal/security/accept.js";
import {
  type RefreshInventoryIntent,
  type RefreshInventoryPlan,
  type RefreshInventoryOutcome,
  type RefreshInventoryPlanError,
  type RefreshInventoryApplyError,
} from "./internal/inventory/refresh.js";
export {
  RefreshInventoryIntent,
  RefreshInventoryPlan,
  RefreshInventoryChange,
  type RefreshInventoryResult,
  type RefreshInventoryOutcome,
  type RefreshInventoryPlanError,
  type RefreshInventoryApplyError,
} from "./internal/inventory/refresh.js";
import { type UndoPlanError, type UndoApplyError } from "./internal/setup/undo.js";
import type { UndoIntent, UndoPlan, UndoResult } from "./internal/setup/undo-plan.js";
import { Context, Effect, Layer } from "effect";
import {
  type StagedContent,
  type ContentSource,
  type ContentStageError,
} from "./internal/content/content.js";
import type { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
import type { CollectionVersionPlan } from "./collection-version-plan.js";
import type { Digest } from "effect/crypto";
import { InstalledSkills } from "./installed-skills.js";
import type { InventoryRootOptions } from "./routing/roots.js";
import { type LibraryStateReadError } from "./store/library-store.js";
import { OperationStatus } from "./store/state-schema.js";
import { type LibraryAuditEvent, type LibraryAuditInvalid } from "./audit/audit-log.js";
import { type Snapshot } from "./snapshot.js";
import { type SetupError, type SetupResult, type StartupRecovery } from "./setup.js";
import type { SetupStep } from "./store/state-schema.js";
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
  type ApplyError,
  type Approval,
  type Intent,
  type Outcome as ExistingOutcome,
  type Plan,
  type PlanError,
} from "./library-plan.js";
export * from "./library-plan.js";
export { UndoIntent, UndoPlan, UndoChange, type UndoResult } from "./internal/setup/undo-plan.js";
export type { UndoPlanError, UndoApplyError } from "./internal/setup/undo.js";
export { reviewInstalledSkillChanges } from "./installed-skill-review.js";
export {
  InvalidIntent,
  calculateEnabled,
  enabledCollections,
  uniqueInstallScopes,
  sameInstallScope,
} from "./enabled-plan.js";
export type { Subject, Invocation, EnabledCollection, SetupApproval } from "./enabled-plan.js";

export { Revision, type Snapshot } from "./snapshot.js";
export type { SetupError, SetupResult, SetupStepResult, StartupRecovery } from "./setup.js";
export type {
  StagedContent,
  ContentSource,
  ContentStageError,
} from "./internal/content/content.js";
export type {
  AbsentEvidence,
  FolderEvidence,
  LinkEvidence,
  ManageExistingSelection,
  ManageNewSelection,
  ReviewedInstalledSkillChange,
  SetupStep,
  SetupStopReason,
  StepRouting,
  VersionChoice,
} from "./store/state-schema.js";
export { OperationStatus } from "./store/state-schema.js";

export interface History {
  readonly events: readonly LibraryAuditEvent[];
  readonly operations: readonly OperationStatus[];
}

/** The operation applied, with its complete or partial result kept intact. */
export interface EnabledOutcome {
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
export interface UninstallOutcome {
  readonly _tag: "Uninstall";
  readonly result: ExistingOutcome;
}
export interface UndoOutcome {
  readonly _tag: "Undo";
  readonly result: UndoResult;
}
export type Outcome =
  | EnabledOutcome
  | RemoveOutcome
  | UpdateOutcome
  | UninstallOutcome
  | UndoOutcome
  | ManageOutcome
  | AcceptFindingOutcome
  | RefreshInventoryOutcome;

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
  readonly plan: {
    (
      intent: ManageIntent,
      options: { readonly base: Snapshot },
    ): Effect.Effect<ManagePlan, ManagePlanError | InstalledSkills.Cause>;
    (
      intent: AcceptFindingIntent,
      options: { readonly base: Snapshot },
    ): Effect.Effect<AcceptFindingPlan, AcceptFindingPlanError>;
    (
      intent: RefreshInventoryIntent,
      options: { readonly base: Snapshot },
    ): Effect.Effect<RefreshInventoryPlan, RefreshInventoryPlanError>;
    (
      intent: UndoIntent,
      options: { readonly base: Snapshot },
    ): Effect.Effect<UndoPlan, UndoPlanError>;
    <I extends Intent>(
      intent: I,
      options: { readonly base: Snapshot; readonly approvals?: readonly Approval[] },
    ): Effect.Effect<Extract<Plan, { readonly _tag: I["_tag"] }>, PlanError>;
  };
  readonly apply: {
    (plan: ManagePlan): Effect.Effect<ManageOutcome, ManageApplyError>;
    (plan: AcceptFindingPlan): Effect.Effect<AcceptFindingOutcome, AcceptFindingApplyError>;
    (
      plan: RefreshInventoryPlan,
    ): Effect.Effect<RefreshInventoryOutcome, RefreshInventoryApplyError>;
    (plan: UndoPlan): Effect.Effect<UndoOutcome, UndoApplyError>;
    <P extends Plan>(
      plan: P,
    ): Effect.Effect<Extract<Outcome, { readonly _tag: P["_tag"] }>, ApplyError>;
  };
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
    readonly edit: (request: EditImport) => Effect.Effect<ImportedEdit, ImportEditError>;
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
      | { readonly _tag: "Changed"; readonly hash: import("../vocabulary.js").Hash },
      LibraryStateReadError
    >;
    readonly pack: (
      snapshot: Snapshot,
    ) => Effect.Effect<readonly SnapshotArchive[], LibraryStateReadError>;
    readonly stage: <E = never, R = never>(
      target: LibraryManifest,
      source: ContentSource<E, R>,
    ) => Effect.Effect<StagedContent, ContentStageError | E, R>;
  };
  /** Audit events and recorded operations, including Pending and Stopped setup. Never writes. */
  readonly history: Effect.Effect<History, LibraryStateReadError | LibraryAuditInvalid>;
  /** What startup recovery did when the layer was built. */
  readonly startup: StartupRecovery;
}
export class Service extends Context.Service<Service, Interface>()("skit/library/Library") {}

/** Compatibility construction; callers migrate to the single public layer. */
export const make = makeWithRouting();
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
  import("./store/library-store.js").LibraryStoreLayerError,
  TreeRequirements | Digest.Digest
> => {
  return Layer.effect(Service, Service).pipe(Layer.provide(ownerLayer(config)));
};
export * as Library from "./library.js";
