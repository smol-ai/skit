import {
  planManaging,
  applyManaging,
  checkedManageIntent,
  type ManageIntent,
  type ManagePlan,
  type ManageOutcome,
  type ManagePlanError,
  type ManageApplyError,
} from "./manage/manage.js";
import { stepRouting } from "../routing/step.js";
import {
  planAcceptance,
  applyAcceptance,
  type AcceptFindingIntent,
  type AcceptFindingPlan,
  type AcceptFindingOutcome,
  type AcceptFindingPlanError,
  type AcceptFindingApplyError,
} from "./security/accept.js";
import {
  planInventory,
  applyInventory,
  type RefreshInventoryIntent,
  type RefreshInventoryPlan,
  type RefreshInventoryOutcome,
  type RefreshInventoryPlanError,
  type RefreshInventoryApplyError,
} from "./inventory/refresh.js";
import { planUndo, applyUndo, type UndoPlanError, type UndoApplyError } from "./setup/undo.js";
import type { UndoIntent, UndoPlan } from "./setup/undo-plan.js";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  inspectContent,
  planContent,
  packContent,
  stageContent,
  type ContentSource,
} from "./content/content.js";
import type { LibraryManifest } from "../library-contracts.js";
import type { Digest } from "effect/crypto";
import { InstalledSkills } from "../installed-skills.js";
import { libraryStoreLayer } from "../library-store-layer.js";
import { treeHasherLayer } from "../../artifact/tree-hasher.js";
import { LibraryStore, withLibraryWriter } from "../store/library-store.js";
import { emptyLibraryState } from "../library-state.js";
import { InvalidLibraryState } from "../../failures.js";
import { type StepRouting, OperationStatus } from "../store/state-schema.js";
import { readLibraryAudit } from "../audit/audit-log.js";
import { snapshotOf, type Snapshot } from "../snapshot.js";
import { setup } from "../setup.js";
import { importCollection, importAuthoredCollection, importEdit } from "../import-collection.js";
import type { TreeRequirements } from "../../platform/tree-requirements.js";
import {
  StalePlan,
  type ApplyError,
  type Approval,
  type Intent,
  type Plan,
  type PlanError,
} from "../library-plan.js";
import { planIntent } from "../plan-changes.js";
import { apply } from "../apply-plan.js";
import {
  Service,
  type Config,
  type Routing,
  type History,
  type Outcome,
  type UndoOutcome,
} from "../library.js";

export const makeWithRouting = Effect.fn("Library.make")(function* (configuration?: Routing) {
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
            download: (hash: import("../../vocabulary.js").Hash) =>
              download(hash).pipe(Effect.provide(caller)),
          }),
    }).pipe(
      Effect.provideService(LibraryStore, store),
      Effect.provide(importing),
      Effect.provide(contentHttp),
    );
  });

  function planFor(
    intent: ManageIntent,
    options: { readonly base: Snapshot },
  ): Effect.Effect<ManagePlan, ManagePlanError | InstalledSkills.Cause>;
  function planFor(
    intent: AcceptFindingIntent,
    options: { readonly base: Snapshot },
  ): Effect.Effect<AcceptFindingPlan, AcceptFindingPlanError>;
  function planFor(
    intent: RefreshInventoryIntent,
    options: { readonly base: Snapshot },
  ): Effect.Effect<RefreshInventoryPlan, RefreshInventoryPlanError>;
  function planFor(
    intent: UndoIntent,
    options: { readonly base: Snapshot },
  ): Effect.Effect<UndoPlan, UndoPlanError>;
  function planFor<I extends Intent>(
    intent: I,
    options: { readonly base: Snapshot; readonly approvals?: readonly Approval[] },
  ): Effect.Effect<Extract<Plan, { readonly _tag: I["_tag"] }>, PlanError>;
  function planFor(
    intent: ManageIntent | AcceptFindingIntent | RefreshInventoryIntent | UndoIntent | Intent,
    options: { readonly base: Snapshot; readonly approvals?: readonly Approval[] },
  ): Effect.Effect<
    ManagePlan | AcceptFindingPlan | RefreshInventoryPlan | UndoPlan | Plan,
    ManagePlanError | AcceptFindingPlanError | RefreshInventoryPlanError | UndoPlanError | PlanError
  > {
    const snapshot = structuredClone(options.base);
    if (snapshot._tag !== "Present" && snapshot._tag !== "Absent")
      return Effect.fail(
        new StalePlan({ message: "Planning requires the displayed Library snapshot" }),
      );
    const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
    if (
      snapshot.revision !==
      snapshotOf(snapshot._tag === "Present" ? { present: true, state } : { present: false })
        .revision
    )
      return Effect.fail(new StalePlan({ message: "The displayed Library snapshot was changed" }));
    if (intent._tag === "Manage") {
      return Effect.gen(function* () {
        const checked = yield* checkedManageIntent(intent);
        const installs = checked.selections.some(
          (selection) =>
            Option.getOrUndefined(selection.duplicates) !== "retain-only" &&
            (selection.mode === "existing" || Option.isSome(selection.ownership)),
        );
        let routing: StepRouting = { active: [], destinations: [], readable: [] };
        if (installs) {
          if (configuration?._tag === "Configured")
            routing = yield* stepRouting(configuration, state);
          else {
            const scopes = [
              { kind: "global" as const },
              ...state.repositories.map(({ root }) => ({ kind: "repository" as const, root })),
            ];
            routing = {
              active: yield* files.active,
              readable: [],
              destinations: (yield* Effect.forEach(scopes, (scope) =>
                Effect.map(files.destinations(scope), (targets) =>
                  targets.map((target) => ({ scope, ...target })),
                ),
              )).flat(),
            };
          }
        }
        return yield* planManaging(checked, { base: snapshot, routing });
      }).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(importing),
      );
    }
    if (intent._tag === "AcceptFinding") {
      return planAcceptance(intent, { base: snapshot }).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(importing),
      );
    }
    if (intent._tag === "RefreshInventory") {
      return planInventory(intent, { base: snapshot }).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(importing),
      );
    }
    if (intent._tag === "Undo") {
      return planUndo(intent, { base: snapshot }).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    }
    return planIntent(intent, { base: state, approvals: options.approvals }).pipe(
      Effect.map((plan) => ({ ...plan, baseRevision: snapshot.revision })),
      Effect.provideService(LibraryStore, store),
      Effect.provideService(InstalledSkills.Service, files),
    );
  }
  function applyFor(plan: ManagePlan): Effect.Effect<ManageOutcome, ManageApplyError>;
  function applyFor(
    plan: AcceptFindingPlan,
  ): Effect.Effect<AcceptFindingOutcome, AcceptFindingApplyError>;
  function applyFor(
    plan: RefreshInventoryPlan,
  ): Effect.Effect<RefreshInventoryOutcome, RefreshInventoryApplyError>;
  function applyFor(plan: UndoPlan): Effect.Effect<UndoOutcome, UndoApplyError>;
  function applyFor<P extends Plan>(
    plan: P,
  ): Effect.Effect<Extract<Outcome, { readonly _tag: P["_tag"] }>, ApplyError>;
  function applyFor(
    plan: ManagePlan | AcceptFindingPlan | RefreshInventoryPlan | UndoPlan | Plan,
  ): Effect.Effect<
    Outcome,
    | ManageApplyError
    | AcceptFindingApplyError
    | RefreshInventoryApplyError
    | UndoApplyError
    | ApplyError
  > {
    if (plan._tag !== plan.intent._tag)
      return Effect.fail(
        new StalePlan({ message: "The plan tag does not match its reviewed intent" }),
      );
    if (plan._tag === "Manage")
      return applyManaging(plan).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    if (plan._tag === "AcceptFinding")
      return applyAcceptance(plan).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    if (plan._tag === "RefreshInventory")
      return applyInventory(plan).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(importing),
      );
    if (plan._tag === "Undo")
      return applyUndo(plan).pipe(
        Effect.map((result) => ({ _tag: "Undo" as const, result })),
        Effect.provideService(LibraryStore, store),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    return apply(plan).pipe(
      Effect.map((result) => ({ _tag: plan._tag, result })),
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
export const ownerLayer = (
  config: Config,
): Layer.Layer<
  Service | LibraryStore,
  import("../store/library-store.js").LibraryStoreLayerError,
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
  return Layer.effect(Service, makeWithRouting(config.routing)).pipe(
    Layer.provide(files),
    Layer.provideMerge(storage),
  );
};
