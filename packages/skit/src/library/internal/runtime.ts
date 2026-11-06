import { listRecoveryOperations, inspectRecoveryOperation } from "./recovery/moves.js";
import { resolve } from "node:path";
import { planRestore, applyRestore } from "./recovery/restore.js";
import { planSync, applySync, type SyncApplyRequest } from "./sync/sync.js";
import { planManaging, applyManaging, checkedManageIntent } from "./manage/manage.js";
import { stepRouting } from "../routing/step.js";
import { planAcceptance, applyAcceptance } from "./security/accept.js";
import { planInventory, applyInventory } from "./inventory/refresh.js";
import { planUndo, applyUndo } from "./setup/undo.js";
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Struct } from "effect";
import { LinkStat } from "../../platform/link-stat.js";
import { SourceProcess } from "../../platform/source-process.js";
import { HttpClient } from "effect/http";
import {
  inspectContent,
  planContent,
  packContent,
  stageContent,
  type ContentSource,
} from "./content/content.js";
import type { LibraryManifest } from "../library-contracts.js";
import type { LibraryState } from "../library-state.js";
import { Digest } from "effect/crypto";
import * as InstalledSkills from "../installed-skills.js";
import {
  LibraryWriter,
  libraryStatePath,
  loadLibrary,
  writeLibrary,
  inspectLocalLibraryState,
  migrateLocalLibraryState,
  recoverLibraryHistory,
} from "../store/library-store.js";
import { InvalidLibraryState, type LibraryChanged } from "../failures.js";
import { type StepRouting, OperationStatus } from "../store/state-schema.js";
import { readLibraryAudit } from "../audit/audit-log.js";
import { snapshotOf, type Snapshot } from "../snapshot.js";
import { recover, setup, applyRecorded } from "./setup/run.js";
import { planningState } from "../reviewed-plan.js";
import { importCollection, importAuthoredCollection, importEdit } from "../import-collection.js";
import type { TreeRequirements } from "../../platform/tree-requirements.js";
import { StalePlan, type Approval } from "../library-plan.js";
import { planIntent } from "../plan-changes.js";
import type { InventoryRootOptions } from "../routing/roots.js";
import type {
  Interface,
  Config,
  History,
  Outcome,
  PlanningIntent,
  ReviewedPlan,
  PlanError as PlanningError,
  ApplyRequest,
  ApplyError as ApplyingError,
} from "../library.js";

/**
 * The Library over `home`, writing installed skills through the `InstalledSkills` it is given:
 * migrates a legacy state.json, then resumes any operation left Pending.
 */
const make = Effect.fn("Library.make")(function* (home: string, roots: InventoryRootOptions) {
  yield* migrateLocalLibraryState(home);
  const activeWriter = yield* Effect.serviceOption(LibraryWriter);
  if (Option.isNone(activeWriter) || activeWriter.value.home !== resolve(home))
    yield* recoverLibraryHistory(home);
  const startup = yield* recover(home);
  const files = yield* InstalledSkills.Service;
  /** A change that adds no routes (Remove, Uninstall) works only where copies already are. */
  const recordedFiles = Effect.fn("Library.recordedFiles")(function* (state: LibraryState) {
    return yield* InstalledSkills.make(yield* InstalledSkills.recordedRouting(state));
  });
  const addsNoRoutes = (tag: string) => tag === "Remove" || tag === "Uninstall";
  // Only the platform services: an owner built inside a write must never carry that writer out.
  const writer = Context.pick(FileSystem.FileSystem)(
    yield* Effect.context<FileSystem.FileSystem>(),
  );
  // The platform's HTTP client is captured like its filesystem: an owner never picks a transport.
  const importing = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    LinkStat,
    SourceProcess,
    Digest.Digest,
    HttpClient.HttpClient,
  )(yield* Effect.context<TreeRequirements | Digest.Digest | HttpClient.HttpClient>());
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
            download: (hash: import("../../shared/hash.js").Hash) =>
              download(hash).pipe(Effect.provide(caller)),
          }),
    }).pipe(Effect.provide(writer), Effect.provide(importing));
  });

  function planFor<I extends PlanningIntent>(
    intent: I,
    options: {
      readonly base: Snapshot;
      readonly approvals?: readonly Approval[];
    },
  ): Effect.Effect<Extract<ReviewedPlan, { readonly _tag: I["_tag"] }>, PlanningError>;
  function planFor(
    intent: PlanningIntent,
    options: {
      readonly base: Snapshot;
      readonly approvals?: readonly Approval[];
    },
  ): Effect.Effect<ReviewedPlan, PlanningError> {
    // The plan owns its Snapshot from the call, not from when its Effect runs.
    const base = structuredClone(options.base);
    if (intent._tag === "Restore")
      return planRestore(home, structuredClone(intent), { base }).pipe(Effect.provide(importing));
    const planning = Effect.provideService(InstalledSkills.Service, files);
    if (intent._tag === "Sync")
      return planSync(home, intent, { base, roots }).pipe(planning, Effect.provide(importing));
    if (intent._tag === "Manage")
      return Effect.gen(function* () {
        const state = yield* planningState(home, base);
        const checked = yield* checkedManageIntent(intent);
        const installs = checked.selections.some(
          (selection) =>
            Option.getOrUndefined(selection.duplicates) !== "retain-only" &&
            (selection.mode === "existing" || Option.isSome(selection.ownership)),
        );
        const routing: StepRouting = installs
          ? yield* stepRouting(roots, state)
          : { active: [], destinations: [], readable: [] };
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
      const state = yield* planningState(home, base);
      return yield* planIntent(intent, {
        home,
        base,
        approvals: options.approvals,
      }).pipe(
        Effect.provideService(
          InstalledSkills.Service,
          addsNoRoutes(intent._tag) ? yield* recordedFiles(state) : files,
        ),
      );
    }).pipe(Effect.provide(importing), Effect.provide(writer));
  }
  function applyFor<Request extends ApplyRequest>(
    request: Request,
  ): Effect.Effect<Extract<Outcome, { readonly _tag: Request["plan"]["_tag"] }>, ApplyingError>;
  function applyFor(request: ApplyRequest): Effect.Effect<Outcome, ApplyingError> {
    return applyRequest(request).pipe(
      Effect.catchTag("LibraryChanged", () =>
        Effect.fail(
          new StalePlan({
            message: "The Library changed before the reviewed change could be saved",
          }),
        ),
      ),
    );
  }
  function applyRequest(
    request: ApplyRequest,
  ): Effect.Effect<Outcome, ApplyingError | LibraryChanged> {
    const applying = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(writer),
        Effect.provide(importing),
      );
    const syncing = (request: SyncApplyRequest) =>
      applySync(home, request, { roots }).pipe(applying);
    if (request._tag === "ApplySynced") return syncing(request);
    const plan = request.plan;
    if (plan._tag === "Sync") return syncing({ _tag: "Apply", plan });
    if (plan._tag === "Restore") return applyRestore(home, plan).pipe(applying);
    if (plan._tag !== plan.intent._tag)
      return Effect.fail(
        new StalePlan({
          message: "The plan tag does not match its reviewed intent",
        }),
      );
    if (plan._tag === "Manage") return applyManaging(home, plan).pipe(applying);
    if (plan._tag === "AcceptFinding") return applyAcceptance(home, plan).pipe(applying);
    if (plan._tag === "RefreshInventory") return applyInventory(home, plan).pipe(applying);
    if (plan._tag === "Undo")
      return applyUndo(home, plan).pipe(
        Effect.map((result) => ({ _tag: "Undo" as const, result })),
        applying,
      );
    return writeLibrary(
      home,
      addsNoRoutes(plan._tag)
        ? applyRecorded(plan, "recorded").pipe(
            Effect.provideServiceEffect(
              InstalledSkills.Service,
              Effect.flatMap(loadLibrary(home), recordedFiles),
            ),
          )
        : applyRecorded(plan, roots),
    ).pipe(
      Effect.map((result) => ({ _tag: plan._tag, result })),
      applying,
    );
  }

  return {
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
      return {
        events,
        operations: operations.map(({ steps, ...operation }) => ({
          ...(operation._tag === "Pending" ? Struct.omit(operation, ["preparation"]) : operation),
          steps: steps.map(({ applies: _applies, ...step }) => step),
        })),
      } satisfies History;
    }).pipe(Effect.provide(writer), Effect.provide(importing)),
    recovery: {
      list: listRecoveryOperations(home).pipe(Effect.provide(importing)),
      inspect: (operationId) =>
        inspectRecoveryOperation(home, operationId).pipe(Effect.provide(importing)),
    },
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
  } satisfies Interface;
});

/** Routes installed skills from this device's roots. */
export const makeOwner = (config: Config) =>
  make(config.home, config.roots).pipe(
    Effect.provideServiceEffect(InstalledSkills.Service, InstalledSkills.make(config.roots)),
  );
