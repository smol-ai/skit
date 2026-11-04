import {
  planSync,
  applySync,
  type SyncIntent,
  type SyncPlan,
  type SyncOutcome,
  type SyncApplyRequest,
  type SyncPlanError,
  type SyncApplyError,
} from "./sync/sync.js";
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
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { LinkStat } from "../../platform/link-stat.js";
import { SourceProcess } from "../../platform/source-process.js";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  inspectContent,
  planContent,
  packContent,
  stageContent,
  type ContentSource,
} from "./content/content.js";
import type { LibraryManifest } from "../library-contracts.js";
import { Digest } from "effect/crypto";
import { InstalledSkills } from "../installed-skills.js";
import { treeHasherLayer } from "../../artifact/tree-hasher.js";
import {
  libraryStatePath,
  loadLibrary,
  writeLibrary,
  inspectLocalLibraryState,
  migrateLocalLibraryState,
} from "../store/library-store.js";
import { InvalidLibraryState } from "../../failures.js";
import { type StepRouting, OperationStatus } from "../store/state-schema.js";
import { readLibraryAudit } from "../audit/audit-log.js";
import { snapshotOf, type Snapshot } from "../snapshot.js";
import { recover, setup, applyRecorded } from "../setup.js";
import { planningState } from "../reviewed-plan.js";
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
import {
  Service,
  type Config,
  type Routing,
  type History,
  type Outcome,
  type UndoOutcome,
} from "../library.js";

/**
 * The Library over `home`, writing installed skills through the `InstalledSkills` it is given:
 * migrates a legacy state.json, then resumes any operation left Pending.
 */
export const make = Effect.fn("Library.make")(function* (
  home: string,
  configuration: Routing = { _tag: "Recorded" },
) {
  yield* migrateLocalLibraryState(home);
  const startup = yield* recover(home).pipe(Effect.provide(treeHasherLayer));
  const files = yield* InstalledSkills.Service;
  // Only the platform services: an owner built inside a write must never carry that writer out.
  const writer = Context.pick(FileSystem.FileSystem)(
    yield* Effect.context<FileSystem.FileSystem>(),
  );
  const importing = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    LinkStat,
    SourceProcess,
    Digest.Digest,
  )(yield* Effect.context<TreeRequirements | Digest.Digest>());
  const suppliedHttp = yield* Effect.serviceOption(HttpClient.HttpClient);
  const contentHttp = Option.isSome(suppliedHttp)
    ? Layer.succeed(HttpClient.HttpClient, suppliedHttp.value)
    : FetchHttpClient.layer;
  /** Every import holds the Library writer, and its staging ends with the import. */
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    writeLibrary(home, Effect.scoped(effect)).pipe(
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
    return yield* stageContent(home, target, {
      ...source,
      ...(download === undefined
        ? {}
        : {
            download: (hash: import("../../vocabulary.js").Hash) =>
              download(hash).pipe(Effect.provide(caller)),
          }),
    }).pipe(Effect.provide(writer), Effect.provide(importing), Effect.provide(contentHttp));
  });

  function planFor(
    intent: SyncIntent,
    options: { readonly base: Snapshot },
  ): Effect.Effect<SyncPlan, SyncPlanError>;
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
    intent:
      | SyncIntent
      | ManageIntent
      | AcceptFindingIntent
      | RefreshInventoryIntent
      | UndoIntent
      | Intent,
    options: { readonly base: Snapshot; readonly approvals?: readonly Approval[] },
  ): Effect.Effect<
    SyncPlan | ManagePlan | AcceptFindingPlan | RefreshInventoryPlan | UndoPlan | Plan,
    | SyncPlanError
    | ManagePlanError
    | AcceptFindingPlanError
    | RefreshInventoryPlanError
    | UndoPlanError
    | PlanError
  > {
    // The plan owns its Snapshot from the call, not from when its Effect runs.
    const base = structuredClone(options.base);
    const planning = Effect.provideService(InstalledSkills.Service, files);
    if (intent._tag === "Sync")
      return planSync(home, intent, {
        base,
        none: configuration._tag === "None",
        ...(configuration._tag === "Configured" ? { roots: configuration } : {}),
      }).pipe(planning, Effect.provide(importing), Effect.provide(treeHasherLayer));
    if (intent._tag === "Manage")
      return Effect.gen(function* () {
        const state = yield* planningState(home, base);
        const checked = yield* checkedManageIntent(intent);
        const installs = checked.selections.some(
          (selection) =>
            Option.getOrUndefined(selection.duplicates) !== "retain-only" &&
            (selection.mode === "existing" || Option.isSome(selection.ownership)),
        );
        let routing: StepRouting = { active: [], destinations: [], readable: [] };
        if (installs) {
          if (configuration._tag === "Configured")
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
        return yield* planManaging(home, checked, { base, routing });
      }).pipe(planning, Effect.provide(importing));
    if (intent._tag === "AcceptFinding")
      return planAcceptance(home, intent, { base }).pipe(planning, Effect.provide(importing));
    if (intent._tag === "RefreshInventory")
      return planInventory(home, intent, { base }).pipe(planning, Effect.provide(importing));
    if (intent._tag === "Undo")
      return planUndo(home, intent, { base }).pipe(
        Effect.provide(writer),
        Effect.provide(importing),
      );
    return Effect.gen(function* () {
      yield* planningState(home, base);
      return yield* planIntent(intent, { home, base, approvals: options.approvals });
    }).pipe(planning, Effect.provide(writer));
  }
  function applyFor(request: SyncApplyRequest): Effect.Effect<SyncOutcome, SyncApplyError>;
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
    plan:
      | SyncApplyRequest
      | ManagePlan
      | AcceptFindingPlan
      | RefreshInventoryPlan
      | UndoPlan
      | Plan,
  ): Effect.Effect<
    Outcome,
    | SyncApplyError
    | ManageApplyError
    | AcceptFindingApplyError
    | RefreshInventoryApplyError
    | UndoApplyError
    | ApplyError
  > {
    const applying = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    if (plan._tag === "Apply" || plan._tag === "ApplySynced")
      return applySync(home, plan, {
        none: configuration._tag === "None",
        ...(configuration._tag === "Configured" ? { roots: configuration } : {}),
      }).pipe(applying, Effect.provide(treeHasherLayer));
    if (plan._tag !== plan.intent._tag)
      return Effect.fail(
        new StalePlan({ message: "The plan tag does not match its reviewed intent" }),
      );
    if (plan._tag === "Manage") return applyManaging(home, plan).pipe(applying);
    if (plan._tag === "AcceptFinding") return applyAcceptance(home, plan).pipe(applying);
    if (plan._tag === "RefreshInventory") return applyInventory(home, plan).pipe(applying);
    if (plan._tag === "Undo")
      return applyUndo(home, plan).pipe(
        Effect.map((result) => ({ _tag: "Undo" as const, result })),
        applying,
      );
    return writeLibrary(home, applyRecorded(plan, configuration)).pipe(
      Effect.map((result) => ({ _tag: plan._tag, result })),
      applying,
    );
  }

  return Service.of({
    read: Effect.map(inspectLocalLibraryState(home), snapshotOf).pipe(Effect.provide(writer)),
    history: Effect.gen(function* () {
      const state = yield* loadLibrary(home);
      const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
        state.operations,
      ).pipe(
        Effect.mapError(
          () =>
            new InvalidLibraryState({
              path: libraryStatePath(home),
              detail: "invalid operation history",
            }),
        ),
      );
      const events = yield* readLibraryAudit(home);
      return { events, operations } satisfies History;
    }).pipe(Effect.provide(writer)),
    plan: planFor,
    apply: applyFor,
    import: {
      collection: (request) => owned(importCollection(request)),
      authored: (request) => owned(importAuthoredCollection(request)),
      edit: (request) => owned(importEdit(request)),
    },
    startup,
    content: {
      plan: (target, localArchives) =>
        planContent(home, target, localArchives).pipe(
          Effect.provide(writer),
          Effect.provide(importing),
        ),
      inspect: (snapshot) =>
        inspectContent(home, snapshot).pipe(Effect.provide(writer), Effect.provide(importing)),
      pack: (snapshot) =>
        packContent(home, snapshot).pipe(Effect.provide(writer), Effect.provide(importing)),
      stage: stageFor,
    },
    setup: (steps, options) =>
      writeLibrary(home, setup(steps, options)).pipe(
        Effect.provide(writer),
        Effect.provide(importing),
      ),
  });
}, Effect.provide(treeHasherLayer));

/** Routes installed skills as `config.routing` says; recorded routing is read after migration. */
export const ownerLayer = (config: Config) =>
  Layer.effect(Service, make(config.home, config.routing)).pipe(
    Layer.provide(
      Layer.effect(
        InstalledSkills.Service,
        Effect.gen(function* () {
          if (config.routing._tag === "None") return yield* InstalledSkills.make();
          if (config.routing._tag === "Configured")
            return yield* InstalledSkills.make(config.routing);
          yield* migrateLocalLibraryState(config.home);
          return yield* InstalledSkills.make(
            yield* InstalledSkills.recordedRouting(yield* loadLibrary(config.home)),
          );
        }),
      ).pipe(Layer.provide(treeHasherLayer)),
    ),
  );
