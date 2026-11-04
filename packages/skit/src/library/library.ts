import {
  planUndo,
  applyUndo,
  type UndoPlanError,
  type UndoApplyError,
} from "./internal/setup/undo.js";
import type { UndoIntent, UndoPlan, UndoResult } from "./internal/setup/undo-plan.js";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  inspectContent,
  planContent,
  packContent,
  stageContent,
  type StagedContent,
  type ContentSource,
  type ContentStageError,
} from "./internal/content/content.js";
import type { LibraryManifest, SnapshotArchive } from "./library-contracts.js";
import type { CollectionVersionPlan } from "./collection-version-plan.js";
import type { Digest } from "effect/crypto";
import { InstalledSkills } from "./installed-skills.js";
import { libraryStoreLayer } from "./library-store-layer.js";
import { treeHasherLayer } from "../artifact/tree-hasher.js";
import type { InventoryRootOptions } from "./routing/roots.js";
import {
  LibraryStore,
  withLibraryWriter,
  type LibraryStateReadError,
} from "./store/library-store.js";
import { emptyLibraryState, type LibraryState } from "./library-state.js";
import { InvalidLibraryState } from "../failures.js";
import { OperationStatus } from "./store/state-schema.js";
import {
  readLibraryAudit,
  type LibraryAuditEvent,
  type LibraryAuditInvalid,
} from "./audit/audit-log.js";
import { snapshotOf, type Snapshot } from "./snapshot.js";
import { setup, type SetupError, type SetupResult, type StartupRecovery } from "./setup.js";
import type { SetupStep } from "./store/state-schema.js";
import {
  importCollection,
  importAuthoredCollection,
  importEdit,
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
  StalePlan,
  type ApplyError,
  type Approval,
  type Intent,
  type Outcome,
  type Plan,
  type PlanError,
} from "./library-plan.js";
import { planIntent } from "./plan-changes.js";
import { apply } from "./apply-plan.js";
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

export interface Interface {
  /**
   * One read. Never writes: a legacy state.json was migrated when the layer was built, and a read
   * refuses any state.json that is not the current version.
   */
  readonly read: Effect.Effect<Snapshot, LibraryStateReadError>;
  /**
   * Plan against the Library the front end showed, never a fresh read: apply refuses the plan if
   * the Library has changed since.
   */
  readonly plan: {
    (
      intent: UndoIntent,
      options: { readonly base: Snapshot },
    ): Effect.Effect<UndoPlan, UndoPlanError>;
    (
      intent: Intent,
      options: { readonly base: Snapshot | LibraryState; readonly approvals?: readonly Approval[] },
    ): Effect.Effect<Plan, PlanError>;
  };
  readonly apply: {
    (plan: UndoPlan): Effect.Effect<UndoResult, UndoApplyError>;
    (plan: Plan): Effect.Effect<Outcome, ApplyError>;
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

export const make = Effect.gen(function* () {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const writer = yield* Effect.context<FileSystem.FileSystem>();
  const importing = yield* Effect.context<TreeRequirements | Digest.Digest>();
  const suppliedHttp = yield* Effect.serviceOption(HttpClient.HttpClient);
  const contentHttp = Option.isSome(suppliedHttp)
    ? Layer.succeed(HttpClient.HttpClient, suppliedHttp.value)
    : FetchHttpClient.layer;
  /** Every import holds the Library writer, and its staging ends with the import. */
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withLibraryWriter(Effect.scoped(effect)).pipe(
      Effect.provideService(LibraryStore, store),
      Effect.provide(writer),
      Effect.provide(importing),
    );

  const stageFor = Effect.fn("Library.content.stageOwned")(function* <E = never, R = never>(
    target: LibraryManifest,
    source: ContentSource<E, R>,
  ) {
    // The owner's platform must never replace a download callback's own dependencies.
    const caller = yield* Effect.context<R>();
    const download = source.download;
    return yield* stageContent(target, {
      ...source,
      ...(download === undefined
        ? {}
        : {
            download: (hash: import("../vocabulary.js").Hash) =>
              download(hash).pipe(Effect.provide(caller)),
          }),
    }).pipe(
      Effect.provideService(LibraryStore, store),
      Effect.provide(importing),
      Effect.provide(contentHttp),
    );
  });

  function planFor(
    intent: UndoIntent,
    options: { readonly base: Snapshot },
  ): Effect.Effect<UndoPlan, UndoPlanError>;
  function planFor(
    intent: Intent,
    options: { readonly base: Snapshot | LibraryState; readonly approvals?: readonly Approval[] },
  ): Effect.Effect<Plan, PlanError>;
  function planFor(
    intent: UndoIntent | Intent,
    options: { readonly base: Snapshot | LibraryState; readonly approvals?: readonly Approval[] },
  ): Effect.Effect<UndoPlan | Plan, UndoPlanError | PlanError> {
    if (intent._tag === "Undo") {
      if (!("revision" in options.base))
        return Effect.fail(
          new StalePlan({ message: "Undo requires the displayed Library snapshot" }),
        );
      return planUndo(intent, { base: options.base }).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    }
    const snapshot = "revision" in options.base ? options.base : undefined;
    const state =
      "revision" in options.base
        ? options.base._tag === "Present"
          ? options.base.state
          : emptyLibraryState()
        : options.base;
    if (
      snapshot !== undefined &&
      snapshot.revision !==
        snapshotOf(snapshot._tag === "Present" ? { present: true, state } : { present: false })
          .revision
    )
      return Effect.fail(new StalePlan({ message: "The displayed Library snapshot was changed" }));
    return planIntent(intent, { base: state, approvals: options.approvals }).pipe(
      Effect.map((plan) =>
        snapshot === undefined ? plan : { ...plan, baseRevision: snapshot.revision },
      ),
      Effect.provideService(LibraryStore, store),
      Effect.provideService(InstalledSkills.Service, files),
    );
  }
  function applyFor(plan: UndoPlan): Effect.Effect<UndoResult, UndoApplyError>;
  function applyFor(plan: Plan): Effect.Effect<Outcome, ApplyError>;
  function applyFor(
    plan: UndoPlan | Plan,
  ): Effect.Effect<UndoResult | Outcome, UndoApplyError | ApplyError> {
    if ("_tag" in plan)
      return applyUndo(plan).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    return apply(plan).pipe(
      Effect.provideService(LibraryStore, store),
      Effect.provideService(InstalledSkills.Service, files),
      Effect.provide(writer),
    );
  }

  return Service.of({
    read: Effect.map(store.inspect, snapshotOf),
    history: Effect.gen(function* () {
      const state = yield* store.load;
      const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
        state.operations,
      ).pipe(
        Effect.mapError(
          () =>
            new InvalidLibraryState({
              path: store.statePath,
              detail: "invalid operation history",
            }),
        ),
      );
      const events = yield* readLibraryAudit(store.home);
      return { events, operations } satisfies History;
    }).pipe(Effect.provide(writer)),
    plan: planFor,
    apply: applyFor,
    import: {
      collection: (request) => owned(importCollection(request)),
      authored: (request) => owned(importAuthoredCollection(request)),
      edit: (request) => owned(importEdit(request)),
    },
    startup: store.startup,
    content: {
      plan: (target, localArchives) =>
        planContent(target, localArchives, store.originalsPath, store.statePath).pipe(
          Effect.provide(importing),
        ),
      inspect: (snapshot) =>
        inspectContent(snapshot, store.originalsPath, store.statePath).pipe(
          Effect.provide(importing),
        ),
      pack: (snapshot) =>
        packContent(snapshot, store.originalsPath, store.statePath).pipe(Effect.provide(importing)),
      stage: stageFor,
    },
    setup: (steps, options) =>
      setup(steps, options).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provide(writer),
        Effect.provide(importing),
      ),
  });
});
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
  const storage = libraryStoreLayer({ home: config.home });
  const files = Layer.effect(
    InstalledSkills.Service,
    Effect.gen(function* () {
      if (config.routing._tag === "None") return yield* InstalledSkills.make();
      if (config.routing._tag === "Configured") return yield* InstalledSkills.make(config.routing);
      const store = yield* LibraryStore;
      return yield* InstalledSkills.make(yield* InstalledSkills.recordedRouting(yield* store.load));
    }),
  ).pipe(Layer.provide(storage), Layer.provide(treeHasherLayer));
  return Layer.effect(Service, make).pipe(Layer.provide(Layer.merge(storage, files)));
};
export * as Library from "./library.js";
