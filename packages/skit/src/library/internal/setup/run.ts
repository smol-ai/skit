import {
  loadOperation,
  operationSummary,
  loadOperations,
  LibraryWriter,
  libraryStatePath,
  loadLibrary,
  writeLibrary,
  type LibraryStateReadError,
  type LibraryStateWriteError,
  inspectLocalLibraryState,
} from "../../store/library-store.js";
import type { OperationKind } from "../../store/state-schema.js";
import { LibraryRecoveryNotice } from "../../recovery-notice.js";
import { UpdateSelectionMissing } from "../../setup-failures.js";
import type { SetupWarning } from "../../setup-warning.js";
import { stepError } from "../../store/step-error.js";
import { recordPreparation, prepareRoots } from "./prepare-roots.js";
import { withLock as withHomeLock } from "../../../platform/home-lock.js";
import { runUndo } from "./undo-execution.js";
// Setup: steps saved in state.json before any runs, run in order, each marked Done as it ends
// (ADR-0020, durable Library operations). Never rolls back on its own.

import { Effect, Option, Predicate, Schema } from "effect";
import { TreeError } from "../../../shared/tree-error.js";
import { isAbsolute, resolve } from "node:path";
import { InvalidLibraryState, LibraryChanged, SetupStepsInvalid } from "../../failures.js";
import { pathIsWithin } from "../../../platform/path-identity.js";
import { makeOperationId, type OperationId } from "../../entity-ids.js";
import { type UpdatedCopy, changeWrites } from "../../installed-update.js";
import {
  duplicatesToMove,
  installedPaths,
  runManage,
  runUpdate,
  type ManageResult,
} from "./steps.js";
import { absentEvidence, readPathEvidence } from "../../folder-evidence.js";

import { CurrentSetupOperation, prepareSetupChanges } from "../../store/setup-intent.js";
import { setupIntent } from "../../store/intent.js";
import { recordedLibrary } from "../../store/intent.js";
import { restoreRecorded } from "../recovery/moves.js";
import { moveAside, recoveryDirectory } from "./moves.js";
import { runSyncStep, type SyncStepResult } from "../sync/operation.js";
import { importCollection, type ImportedCollection } from "../../import-collection.js";
import { emptyLibraryState } from "../../library-state.js";
import { StalePlan, type Plan, type Outcome } from "../../library-plan.js";
import { InstalledSkillInvalid } from "../../installation/install-enabled.js";
import { prepareApply } from "../operations/recorded.js";
import { copiesOf } from "../operations/program.js";
import { applyOutcome } from "../operations/result.js";
import { runApply, operationScope } from "../operations/operations.js";
import type { InventoryRootOptions } from "../../routing/roots.js";
import type { StepRouting } from "../../store/state-schema.js";
import { stepRouting } from "../../routing/step.js";
import { snapshotOf, type Snapshot } from "../../snapshot.js";

import {
  OperationStatus,
  type FolderEvidence,
  type LinkEvidence,
  type ManageExistingSelection,
  type ManageNewSelection,
  type RecordedSetupStep,
  type SetupStep,
  type SetupStopReason,
  type StepEvidence,
} from "../../store/state-schema.js";

/** One finished step, by step tag. */
type SetupStepResult =
  | { readonly _tag: "Undo"; readonly operationId: string; readonly backupId: string }
  | {
      readonly _tag: "Restore";
      readonly after: typeof import("../../recovery-facts.js").RecoveryInspection.Type;
    }
  | { readonly _tag: "Apply"; readonly outcome: Outcome }
  | SyncStepResult
  | { readonly _tag: "Import"; readonly imported: ImportedCollection }
  | ManageResult
  | { readonly _tag: "Update"; readonly changes: readonly UpdatedCopy[] }
  | {
      readonly _tag: "Remove";
      readonly recoveryDirectory: string;
      readonly removed: readonly string[];
    };

export type SetupResult =
  | {
      readonly _tag: "Done";
      readonly operationId: OperationId;
      /** One per step this run ran, in order. */
      readonly steps: readonly SetupStepResult[];
      readonly warnings: readonly SetupWarning[];
      readonly recoveryDirectories: readonly string[];
    }
  | {
      /** The user can undo by operationId; Library never rolls back on its own. */
      readonly _tag: "Stopped";
      readonly operationId: OperationId;
      readonly completed: readonly SetupStepResult[];
      readonly reason: SetupStopReason;
    };

/**
 * Failures before the operation is saved: nothing was written. Once the store holds it, every
 * failure is a Stopped result; an interruption leaves it Pending.
 */
export type SetupError =
  | StalePlan
  | SetupStepsInvalid
  | TreeError
  | LibraryStateReadError
  | Exclude<LibraryStateWriteError, LibraryChanged>;

/** What is at each path, as evidence; a missing folder is recorded as "nothing here". */
const observed = (paths: readonly string[]) =>
  Effect.forEach([...new Set(paths)], (path) =>
    Effect.flatMap(readPathEvidence(path), (evidence) =>
      Option.isSome(evidence) ? Effect.succeed<StepEvidence>(evidence.value) : absentEvidence(path),
    ),
  );

/**
 * What a step expects at each path it touches, before it runs and once it has. Where it installs
 * or updates copies, `before` also records what was there, so undo can tell its copies from the
 * user's.
 */
const recordedStep = Effect.fn("Library.setup.recordedStep")(function* (step: SetupStep) {
  switch (step._tag) {
    case "Undo":
    case "Restore":
    case "Apply":
      return { step, before: [], after: [], status: "Pending" } satisfies RecordedSetupStep;
    case "Sync":
      return { step, before: [], after: [], status: "Pending" } satisfies RecordedSetupStep;
    // Import's retained Collection Version is known only once it runs; its Done write saves it,
    // and saves it too in the `after` of each Manage step whose files it imports.
    case "Import":
      return { step, before: [], after: [], status: "Pending" } satisfies RecordedSetupStep;
    case "Update":
      return {
        step,
        updateSelection: "reviewed",
        before: yield* observed(
          step.changes
            .filter(
              (change) =>
                changeWrites(change) ||
                (change.status !== "native-delete" &&
                  step.versionChoices.some((choice) => choice.skillId === change.skillId)),
            )
            .map(({ path }) => path),
        ),
        after: [],
        status: "Pending",
      } satisfies RecordedSetupStep;
    case "Remove":
      return {
        step,
        before: step.folders,
        after: step.folders.map((folder) => ({
          _tag: "Absent",
          path: folder.path,
          parent: folder.parent,
        })),
        status: "Pending",
      } satisfies RecordedSetupStep;
    case "Manage": {
      const selections: readonly (ManageExistingSelection | ManageNewSelection)[] = step.selections;
      const reviewed = selections.flatMap((selection) => [
        selection.source,
        ...(selection.mode === "new" ? selection.equalCopies : []),
        ...duplicatesToMove(step.routing, selection),
      ]);
      return {
        step,
        before: [
          ...reviewed,
          ...(yield* observed(
            selections
              .flatMap((selection) => installedPaths(step.routing, selection))
              .filter((path) => !reviewed.some((evidence) => evidence.path === path)),
          )),
        ],
        after: selections.flatMap((selection) =>
          duplicatesToMove(step.routing, selection).map((folder) => ({
            _tag: "Absent" as const,
            path: folder.path,
            parent: folder.parent,
          })),
        ),
        status: "Pending",
      } satisfies RecordedSetupStep;
    }
  }
});

/** The Import steps whose result a step's "new" selections take their files from. */
const importsUsedBy = (step: SetupStep): readonly number[] =>
  step._tag === "Manage" && step.mode === "new"
    ? step.selections.flatMap((selection) =>
        selection.importFrom._tag === "Step" ? [selection.importFrom.step] : [],
      )
    : [];

/** Every folder a step may move aside. */
const removedBy = (step: SetupStep): readonly (FolderEvidence | LinkEvidence)[] => {
  if (step._tag === "Undo") return step.program.preserve;
  if (step._tag === "Remove") return step.folders;
  if (step._tag !== "Manage") return [];
  const selections: readonly (ManageExistingSelection | ManageNewSelection)[] = step.selections;
  return selections.flatMap((selection) => duplicatesToMove(step.routing, selection));
};

/** Refuse steps setup could not run safely, before anything is written. */
export const checkSteps = (home: string, steps: readonly SetupStep[]) => {
  for (const [index, step] of steps.entries()) {
    if (step._tag !== "Sync" || step.phase === "retire") continue;
    const source = steps[step.sourceStep];
    if (step.sourceStep >= index || source?._tag !== "Sync" || source.phase !== "retire")
      return Option.some(new SetupStepsInvalid({ reason: "sync-program-missing", step: index }));
  }
  for (const step of steps) {
    if (step._tag !== "Undo") continue;
    for (const { path } of step.program.actions)
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        path === resolve(home) ||
        pathIsWithin(path, resolve(home)) ||
        pathIsWithin(resolve(home), path)
      )
        return Option.some(new SetupStepsInvalid({ reason: "undo-path-not-replaceable", path }));
  }
  const firstRemove = steps.findIndex((step) => step._tag === "Remove");
  if (firstRemove >= 0 && steps.slice(firstRemove).some((step) => step._tag !== "Remove"))
    return Option.some(new SetupStepsInvalid({ reason: "removal-not-last" }));
  for (const [index, step] of steps.entries())
    for (const source of importsUsedBy(step))
      if (source >= index || steps[source]?._tag !== "Import")
        return Option.some(new SetupStepsInvalid({ reason: "import-step-missing", step: index }));
  const paths: string[] = [];
  for (const { path } of steps.flatMap(removedBy)) {
    if (!isAbsolute(path) || resolve(path) !== path)
      return Option.some(new SetupStepsInvalid({ reason: "path-not-normalized", path }));
    if (
      path === resolve(home) ||
      pathIsWithin(path, resolve(home)) ||
      pathIsWithin(resolve(home), path)
    )
      return Option.some(new SetupStepsInvalid({ reason: "path-in-library-storage", path }));
    if (
      paths.some(
        (other) => other === path || pathIsWithin(other, path) || pathIsWithin(path, other),
      )
    )
      return Option.some(new SetupStepsInvalid({ reason: "duplicate-removal", path }));
    paths.push(path);
  }
  return Option.none<SetupStepsInvalid>();
};

type StepOutcome =
  | {
      readonly _tag: "Ran";
      readonly result: SetupStepResult;
      readonly after: readonly StepEvidence[];
    }
  | { readonly _tag: "Stop"; readonly reason: SetupStopReason; readonly result?: SetupStepResult };

const runStep = Effect.fn("Library.setup.step")(function* (
  operationId: OperationId,
  index: number,
  steps: readonly RecordedSetupStep[],
) {
  const { home } = yield* LibraryWriter;
  const step = steps[index]!.step;
  switch (step._tag) {
    case "Undo":
      yield* runUndo(operationId, index, step.program);
      return {
        _tag: "Ran",
        result: {
          _tag: "Undo",
          operationId: step.program.operationId,
          backupId: step.program.backupId,
        },
        after: [],
      } satisfies StepOutcome;
    case "Restore":
      return {
        _tag: "Ran",
        result: { _tag: "Restore", after: yield* restoreRecorded(home, step.program) },
        after: [],
      } satisfies StepOutcome;
    case "Apply": {
      const outcome = yield* runApply(operationId, index, step);
      const result: SetupStepResult = { _tag: "Apply", outcome };
      if (outcome._tag === "Incomplete")
        return {
          _tag: "Stop",
          reason: { _tag: "StepFailed", step: index, error: stepError(outcome.cause) },
          result,
        } satisfies StepOutcome;
      return { _tag: "Ran", result, after: [] } satisfies StepOutcome;
    }
    case "Sync":
      return yield* runSyncStep(operationId, index, steps, home);
    case "Import": {
      const imported = yield* Effect.scoped(importCollection(step.request));
      return {
        _tag: "Ran",
        result: { _tag: "Import", imported },
        after: [
          {
            _tag: "Retained",
            hash: imported.snapshotDigest,
            collectionId: imported.collection.collection_id,
          },
        ],
      } satisfies StepOutcome;
    }
    case "Manage":
      return yield* operationScope(operationId, index, step.routing).pipe(
        Effect.flatMap((scope) => Effect.scoped(runManage(operationId, index, step, steps, scope))),
        Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
          Effect.succeed({
            _tag: "Stop" as const,
            reason: {
              _tag: "EvidenceDiffers" as const,
              step: index,
              path: error.path,
              expected: { before: Option.none(), after: Option.none() },
            },
          }),
        ),
      );
    case "Update":
      return yield* operationScope(operationId, index, step.routing).pipe(
        Effect.flatMap((scope) => Effect.scoped(runUpdate(index, step, scope))),
        Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
          Effect.succeed({
            _tag: "Stop" as const,
            reason: {
              _tag: "EvidenceDiffers" as const,
              step: index,
              path: error.path,
              expected: { before: Option.none(), after: Option.none() },
            },
          }),
        ),
      );
    case "Remove": {
      const moved = yield* moveAside(
        operationId,
        recoveryDirectory(home, operationId, index),
        step.folders,
      );
      if (moved._tag === "Differs")
        return {
          _tag: "Stop",
          reason: {
            _tag: "EvidenceDiffers",
            step: index,
            path: moved.folder.path,
            // A removed folder's after is "nothing here", which is neither a folder nor a link.
            expected: { before: Option.some(moved.folder), after: Option.none() },
          },
        } satisfies StepOutcome;
      return {
        _tag: "Ran",
        result: {
          _tag: "Remove",
          recoveryDirectory: moved.directory,
          removed: step.folders.map(({ path }) => path),
        },
        after: step.folders.map((folder) => ({
          _tag: "Absent",
          path: folder.path,
          parent: folder.parent,
        })),
      } satisfies StepOutcome;
    }
  }
});

/**
 * Run the Pending steps of the operation `operationId` records, under the writer that saved it.
 * A step that differs from its record, fails, or finds the operation gone stops the operation;
 * nothing that ran is undone.
 */
const runOperation = Effect.fn("Library.setup.run")(function* (operationId: OperationId) {
  const { home } = yield* LibraryWriter;
  const completed: SetupStepResult[] = [];
  const stop = (reason: SetupStopReason) =>
    Effect.gen(function* () {
      const operation = yield* loadOperation(home, operationId);
      if (Option.isNone(operation) || operation.value._tag !== "Pending")
        return yield* new LibraryChanged({ path: libraryStatePath(home) });
      yield* (yield* LibraryWriter).settleOperation(operation.value, reason);
    }).pipe(
      // Unsaved, the record stays Pending and the next run finds it.
      Effect.catch((error) =>
        Effect.logWarning(
          LibraryRecoveryNotice.cases.SetupStopNotRecorded.make({
            home,
            operationId,
            failure: error,
          }),
        ),
      ),
      Effect.map((): SetupResult => ({ _tag: "Stopped", operationId, completed, reason })),
    );
  const failed = (step: number) => (error: unknown) =>
    stop({ _tag: "StepFailed", step, error: stepError(error) });

  const loaded = yield* Effect.result(loadOperation(home, operationId));
  if (loaded._tag === "Failure") return yield* failed(0)(loaded.failure);
  if (Option.isNone(loaded.success) || loaded.success.value._tag !== "Pending")
    return yield* stop({
      _tag: "LibraryChanged",
      step: 0,
      revision: yield* Effect.orElseSucceed(
        Effect.map(inspectLocalLibraryState(home), (inspected) => snapshotOf(inspected).revision),
        () => snapshotOf({ present: false }).revision,
      ),
    });
  let pending = loaded.success.value;
  // Check before root preparation or replaying any batch: old Update records may include
  // unselected Skills, even when their compiled filesystem actions are exact.
  const ambiguousUpdate = pending.steps.findIndex(
    (saved) =>
      saved.status === "Pending" &&
      saved.step._tag === "Update" &&
      saved.updateSelection !== "reviewed",
  );
  if (ambiguousUpdate !== -1)
    return yield* stop({
      _tag: "StepFailed",
      step: ambiguousUpdate,
      error: new UpdateSelectionMissing(),
    });
  if (pending.preparation) {
    const prepared = yield* Effect.result(prepareRoots(pending.preparation, pending.steps));
    if (prepared._tag === "Failure") {
      const error = prepared.failure;
      return yield* Predicate.isTagged(error, "Library.InstalledSkillsChanged")
        ? stop({
            _tag: "EvidenceDiffers",
            step: 0,
            path: error.path,
            expected: { before: Option.none(), after: Option.none() },
          })
        : failed(0)(error);
    }
    if (!pending.preparation.done) {
      const before = pending;
      pending = { ...pending, ...prepared.success };
      const saved = yield* Effect.result((yield* LibraryWriter).saveOperation(pending, before));
      if (saved._tag === "Failure") return yield* failed(0)(saved.failure);
    }
  }
  const recorded = pending.steps;

  for (const [index, { status }] of recorded.entries()) {
    if (status === "Done") continue;
    // The record as saved now: an earlier step's Done write may have added this step's evidence.
    const current = yield* Effect.result(loadOperation(home, operationId));
    if (current._tag === "Failure") return yield* failed(index)(current.failure);
    const steps =
      Option.isSome(current.success) && current.success.value._tag === "Pending"
        ? current.success.value.steps
        : recorded;
    const outcome = yield* Effect.result(runStep(operationId, index, steps));
    if (outcome._tag === "Failure") return yield* failed(index)(outcome.failure);
    if (outcome.success._tag === "Stop") {
      if ("result" in outcome.success && outcome.success.result)
        completed.push(outcome.success.result);
      return yield* stop(outcome.success.reason);
    }
    const { result, after } = outcome.success;
    // Mark the step Done in the record as it is now: the step itself may have saved it.
    const marked = yield* Effect.result(
      Effect.gen(function* () {
        const operation = yield* loadOperation(home, operationId);
        if (Option.isNone(operation) || operation.value._tag !== "Pending") {
          const current = yield* inspectLocalLibraryState(home);
          return Option.some(snapshotOf(current).revision);
        }
        yield* (yield* LibraryWriter).saveOperation(
          OperationStatus.cases.Pending.make({
            ...operation.value,
            operationId,
            before: operation.value.before,
            // A later step that takes its files from this one records what it retained.
            steps: operation.value.steps.map((saved, at) =>
              at === index
                ? { ...saved, after, status: "Done" }
                : importsUsedBy(saved.step).includes(index)
                  ? { ...saved, after: [...saved.after, ...after] }
                  : saved,
            ),
          }),
          operation.value,
        );
        return Option.none();
      }),
    );
    if (marked._tag === "Failure") return yield* failed(index)(marked.failure);
    if (Option.isSome(marked.success))
      return yield* stop({ _tag: "LibraryChanged", step: index, revision: marked.success.value });
    completed.push(result);
  }
  const finished = yield* Effect.result(
    Effect.gen(function* () {
      const operation = yield* loadOperation(home, operationId);
      if (Option.isNone(operation) || operation.value._tag !== "Pending")
        return yield* new LibraryChanged({ path: libraryStatePath(home) });
      yield* (yield* LibraryWriter).settleOperation(operation.value);
    }),
  );
  if (finished._tag === "Failure") return yield* failed(recorded.length - 1)(finished.failure);
  return {
    _tag: "Done",
    operationId,
    steps: completed,
    warnings: completed.flatMap((step) => (step._tag === "Manage" ? step.warnings : [])),
    recoveryDirectories: completed.flatMap((step) =>
      step._tag === "Remove"
        ? [step.recoveryDirectory]
        : step._tag === "Manage"
          ? step.recoveryDirectories
          : [],
    ),
  } satisfies SetupResult;
});

/**
 * Save the steps as one Pending operation, then run them. Refuses with `StalePlan` unless the
 * Library is still `base`. A later setup replaces the records of earlier Done ones; Pending and
 * Stopped records stay until undone.
 */
export const setupOperation = Effect.fn("Library.setupOperation")(function* (
  steps: readonly SetupStep[],
  options: {
    readonly base: Snapshot;
    readonly operationId: OperationId;
    readonly kind?: OperationKind;
    readonly replaceDone?: boolean;
    readonly machineChoices?: import("../../store/state-schema.js").SetupRecord["machineChoices"];
  },
) {
  const writer = yield* LibraryWriter;
  const invalid = checkSteps(writer.home, steps);
  if (Option.isSome(invalid)) return yield* invalid.value;
  const inspected = yield* inspectLocalLibraryState(writer.home);
  const actual = snapshotOf(inspected).revision;
  if (actual !== options.base.revision)
    return yield* new StalePlan({
      reason: { _tag: "LibraryChanged" },
      expected: options.base.revision,
      actual,
    });
  const state = inspected.present ? inspected.state : emptyLibraryState();
  const operationId = options.operationId;
  const preparation = yield* recordPreparation(steps);
  const pending = yield* OperationStatus.cases.Pending.makeEffect({
    operationId,
    ...(preparation === undefined ? {} : { preparation }),
    steps: yield* Effect.forEach(steps, recordedStep),
    before:
      (options.kind ?? "setup") === "setup"
        ? { installedSkills: structuredClone(state.installed_skills) }
        : recordedLibrary(state),
    ...((options.kind ?? "setup") === "setup"
      ? {
          setup: {
            changes: yield* prepareSetupChanges(
              setupIntent(state),
              setupIntent(state),
              libraryStatePath(writer.home),
            ),
            ...(options.machineChoices === undefined
              ? {}
              : { machineChoices: options.machineChoices }),
          },
        }
      : {}),
  }).pipe(
    Effect.mapError(
      (failure) =>
        new InvalidLibraryState({
          path: libraryStatePath(writer.home),
          reason: { _tag: "SchemaInvalid", failure: new Schema.SchemaError(failure) },
        }),
    ),
  );
  yield* writer
    .recordOperation(pending, options.base, options.kind ?? "setup", options.replaceDone ?? false)
    .pipe(
      Effect.catchTag("LibraryChanged", () =>
        Effect.fail(
          new StalePlan({ reason: { _tag: "LibraryChanged" }, expected: options.base.revision }),
        ),
      ),
    );
  return yield* runOperation(operationId).pipe(
    Effect.provideService(CurrentSetupOperation, operationId),
  );
});

/** Public setup allocates its operation; standalone plans allocate one before their preview. */
export const setup = Effect.fn("Library.setup")(function* (
  steps: readonly SetupStep[],
  options: {
    readonly base: Snapshot;
    readonly machineChoices?: import("../../store/state-schema.js").SetupRecord["machineChoices"];
  },
) {
  return yield* setupOperation(steps, {
    ...options,
    operationId: makeOperationId(),
    replaceDone: true,
  });
});

/** Keep the ordinary apply surface while the existing runner owns its durable lifecycle. */
export const applyRecorded = Effect.fn("Library.applyRecorded")(function* (
  plan: Plan,
  roots: InventoryRootOptions,
) {
  const { home } = yield* LibraryWriter;
  // Enabling and installing read this device's folders; every other plan carries the routes it
  // was made on. Apply refuses a plan whose next Library differs, so the reviewed one is exact.
  const routing: StepRouting =
    plan._tag === "Enabled" || plan._tag === "Install"
      ? yield* stepRouting(roots, plan.next)
      : {
          active: [
            ...new Set(
              plan.routes.flatMap((route) =>
                route.destinations.map((target) => target.destination),
              ),
            ),
          ],
          destinations: plan.routes.flatMap(({ scope, destinations }) =>
            destinations.map((target) => ({ scope, ...target })),
          ),
          readable: [],
        };
  const prepared = yield* prepareApply(home, plan, routing);
  if (prepared.noop) {
    const copies = copiesOf(prepared.step);
    return yield* applyOutcome(
      prepared.step,
      prepared.snapshot._tag === "Present" ? prepared.snapshot.state : emptyLibraryState(),
      { _tag: "Applied", results: [], copies },
    );
  }
  const result = yield* setupOperation([prepared.step], {
    base: prepared.snapshot,
    operationId: makeOperationId(),
    kind: "apply",
  });
  const steps = result._tag === "Done" ? result.steps : result.completed;
  const applied = steps.find((step) => step._tag === "Apply");
  if (applied?._tag !== "Apply")
    return yield* new InstalledSkillInvalid({
      reason: { _tag: "ApplyStopped" },
    });
  const outcome = yield* applyOutcome(prepared.step, yield* loadLibrary(home), applied.outcome);
  // A durable attempt is not saved enablement. Fail normally if root preparation stopped
  // before any requested enablement was accepted; the stopped operation remains inspectable.
  if (
    outcome._tag === "Incomplete" &&
    (plan.intent._tag !== "Enabled" || outcome.results.length === 0)
  )
    return yield* outcome.cause;
  return outcome;
}, Effect.scoped);

type StoppedOperation = Extract<OperationStatus, { readonly _tag: "Stopped" }>;
type StartupStoppedOperation = Extract<
  import("../../store/state-schema.js").OperationSummary,
  { readonly _tag: "Stopped" }
>;

/** What startup recovery did with the operations it found unfinished. */
export interface StartupRecovery {
  /** Finished: only steps safe to repeat were run. */
  readonly finished: readonly OperationId[];
  /** Stopped instead, each with its reason; the user can undo them. */
  readonly stopped: readonly StartupStoppedOperation[];
}

/**
 * Resume every Pending operation, as after a crash: a step whose effect is complete is skipped,
 * one still as recorded runs, and anything else stops its operation. Never rolls back. Reads
 * the operation rows without the lock first, and takes it only when an operation is Pending. Setups
 * interrupted before operations were recorded in the Library store are not resumed.
 */
export const recover = Effect.fn("Library.recover")(function* (home: string) {
  const operations = loadOperations(home);
  // Unreadable store data is left for ordinary reads to refuse.
  const found = yield* operations.pipe(
    Effect.catchTag("InvalidLibraryState", () => Effect.succeed([])),
  );
  if (!found.some((operation) => operation._tag === "Pending"))
    return { finished: [], stopped: [] } satisfies StartupRecovery;
  return yield* withHomeLock(
    home,
    Effect.gen(function* () {
      const finished: OperationId[] = [];
      const stopped: StoppedOperation[] = [];
      for (const operation of yield* operations) {
        if (operation._tag !== "Pending") continue;
        const result = yield* writeLibrary(
          home,
          runOperation(operation.operationId).pipe(
            Effect.provideService(CurrentSetupOperation, operation.operationId),
          ),
          {
            resume: operation.operationId,
          },
        );
        if (result._tag === "Done") {
          finished.push(operation.operationId);
          continue;
        }
        // As recorded; a stop that could not be saved still reports its steps and reason.
        const saved = yield* loadOperation(home, operation.operationId).pipe(
          Effect.orElseSucceed(() => Option.none<OperationStatus>()),
        );
        stopped.push(
          Option.isSome(saved) && saved.value._tag === "Stopped"
            ? saved.value
            : OperationStatus.cases.Stopped.make({
                operationId: operation.operationId,
                steps: operation.steps,
                reason: result.reason,
                before: operation.before,
                after: operation.before,
                ...(operation.setup === undefined ? {} : { setup: operation.setup }),
              }),
        );
      }
      return {
        finished,
        stopped: stopped.map((operation) => operationSummary(operation)),
      } satisfies StartupRecovery;
    }),
  );
});
