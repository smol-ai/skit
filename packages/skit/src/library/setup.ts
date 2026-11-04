// Setup: steps saved in state.json before any runs, run in order, each marked Done as it ends
// (decisions.md D4, "Crash halfway" and "Setup records"). Never rolls back on its own.

import { Effect, FileSystem, Option, Schema } from "effect";
import { basename, isAbsolute, join, resolve } from "node:path";
import { InvalidLibraryState } from "../failures.js";
import { writeJsonExclusive } from "../platform/atomic-write.js";
import { FileIdentityNumber, LinkStat } from "../platform/link-stat.js";
import { pathIsWithin } from "../platform/path-identity.js";
import { leavePnpmSkill } from "../install/pnpm-skills.js";
import { InvalidIntent } from "./enabled-plan.js";
import { makeOperationId, type OperationId } from "./entity-ids.js";
import {
  absentUnder,
  holdsEvidence,
  parentIsAsRecorded,
  recoveryEntryPath,
} from "./folder-evidence.js";
import { importCollection, type ImportedCollection } from "./import-collection.js";
import { emptyLibraryState, type LibraryState } from "./library-state.js";
import { StalePlan } from "./library-plan.js";
import { snapshotOf, type Snapshot } from "./snapshot.js";
import {
  LibraryStore,
  withLibraryWriter,
  type LibraryStateReadError,
  type LibraryStateWriteError,
} from "./store/library-store.js";
import {
  OperationStatus,
  type FolderEvidence,
  type LinkEvidence,
  type RecordedSetupStep,
  type SetupStep,
  type SetupStopReason,
  type StepEvidence,
} from "./store/state-schema.js";
import { Hash } from "../vocabulary.js";

/** The steps setup runs today. Manage and Update follow. */
export type SupportedSetupStep = Extract<SetupStep, { readonly _tag: "Import" | "Remove" }>;

/** One finished step, by step tag. */
export type SetupStepResult =
  | { readonly _tag: "Import"; readonly imported: ImportedCollection }
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
      readonly warnings: readonly { readonly name: string; readonly message: string }[];
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
 * Failures before the operation is saved: nothing was written. Once state.json holds it, every
 * failure is a Stopped result; an interruption leaves it Pending.
 */
export type SetupError = StalePlan | InvalidIntent | LibraryStateReadError | LibraryStateWriteError;

/** One entry of a step's move receipt, in the format recovery reads (`removed/<id>/<batch>/`). */
const ReceiptEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  recoveryPath: Schema.String,
  type: Schema.Literals(["Directory", "SymbolicLink"]),
  dev: FileIdentityNumber,
  ino: FileIdentityNumber,
  linkTarget: Schema.optionalKey(Schema.String),
  currentHash: Schema.optionalKey(Hash),
  contentHash: Hash,
  approvedMarker: Schema.optionalKey(Schema.String),
  parent: Schema.Struct({ path: Schema.String, dev: FileIdentityNumber, ino: FileIdentityNumber }),
});
const Receipt = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  entries: Schema.Array(ReceiptEntry),
});

const removedPath = (home: string) => join(resolve(home), "removed");
/** A Remove step's recovery directory: fixed by the operation and step, so a re-run finds it. */
const recoveryDirectory = (home: string, operationId: OperationId, step: number) =>
  join(removedPath(home), operationId, `step-${step + 1}`);

const receiptEntry = (
  evidence: FolderEvidence | LinkEvidence,
  recoveryPath: string,
): typeof ReceiptEntry.Type => ({
  name: basename(evidence.path),
  path: evidence.path,
  recoveryPath,
  type: evidence._tag,
  dev: evidence.dev,
  ino: evidence.ino,
  contentHash: evidence.contentHash,
  parent: evidence.parent,
  ...(evidence._tag === "SymbolicLink"
    ? { linkTarget: evidence.linkTarget }
    : {
        currentHash: evidence.treeHash,
        ...Option.match(evidence.marker, {
          onNone: () => ({}),
          onSome: (approvedMarker) => ({ approvedMarker }),
        }),
      }),
});

/** What a step expects at each path it touches, before it runs and once it has. */
const recordedStep = (step: SupportedSetupStep): RecordedSetupStep => ({
  step,
  // Import's retained Collection Version is known only once it runs; its Done write saves it.
  before: step._tag === "Import" ? [] : step.folders,
  after:
    step._tag === "Import"
      ? []
      : step.folders.map((folder) => ({
          _tag: "Absent",
          path: folder.path,
          parent: folder.parent,
        })),
  status: "Pending",
});

/** Refuse steps setup could not run safely, before anything is written. */
const checkSteps = (home: string, steps: readonly SupportedSetupStep[]) => {
  const firstRemove = steps.findIndex((step) => step._tag === "Remove");
  if (firstRemove >= 0 && steps.slice(firstRemove).some((step) => step._tag !== "Remove"))
    return Option.some("Setup removes folders only after every other step");
  const paths: string[] = [];
  for (const step of steps) {
    if (step._tag !== "Remove") continue;
    for (const { path } of step.folders) {
      if (!isAbsolute(path) || resolve(path) !== path)
        return Option.some(`Setup removes only absolute, normalized paths: ${path}`);
      if (
        path === resolve(home) ||
        pathIsWithin(path, resolve(home)) ||
        pathIsWithin(resolve(home), path)
      )
        return Option.some(`Setup cannot remove the Library's own storage: ${path}`);
      if (
        paths.some(
          (other) => other === path || pathIsWithin(other, path) || pathIsWithin(path, other),
        )
      )
        return Option.some(`Setup removes each folder once, and never one inside another: ${path}`);
      paths.push(path);
    }
  }
  return Option.none<string>();
};

const decodeOperations = (state: LibraryState) =>
  Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(state.operations);
const encodeOperation = Schema.encodeEffect(OperationStatus);

/** The decoded operation `operationId` names in `state`, if it records one. */
const operationIn = Effect.fn("Library.setup.operationIn")(function* (
  state: LibraryState,
  operationId: OperationId,
) {
  return Option.fromUndefinedOr(
    (yield* decodeOperations(state)).find((operation) => operation.operationId === operationId),
  );
});

/** Save `operation` in place of the record of the same id, or after the others. */
const saveOperation = Effect.fn("Library.setup.saveOperation")(function* (
  base: LibraryState,
  operation: OperationStatus,
) {
  const store = yield* LibraryStore;
  const encoded = yield* encodeOperation(operation);
  const others = base.operations.filter((other) => other.operationId !== operation.operationId);
  const index = base.operations.findIndex((other) => other.operationId === operation.operationId);
  const operations =
    index < 0 ? [...others, encoded] : [...others.slice(0, index), encoded, ...others.slice(index)];
  yield* store.save({ ...base, operations }, base);
});

type StepOutcome =
  | {
      readonly _tag: "Ran";
      readonly result: SetupStepResult;
      readonly after: readonly StepEvidence[];
    }
  | { readonly _tag: "Stop"; readonly reason: SetupStopReason };

const differs = (step: number, evidence: FolderEvidence | LinkEvidence): StepOutcome => ({
  _tag: "Stop",
  reason: {
    _tag: "EvidenceDiffers",
    step,
    path: evidence.path,
    // A removed folder's after is "nothing here", which is neither a folder nor a link.
    expected: { before: Option.some(evidence), after: Option.none() },
  },
});

/** Create a recovery container, refusing one that is not a plain directory. */
const recoveryContainer = Effect.fn("Library.setup.recoveryContainer")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const exists = yield* fs.exists(path);
  if (!exists) yield* fs.makeDirectory(path, { mode: 0o700 });
  if ((yield* links.identity.lstat(path)).type !== "Directory")
    return yield* new InvalidLibraryState({ path, detail: "recovery directory is redirected" });
});

/**
 * Move each folder aside into the step's recovery directory, writing the receipt first. Safe to
 * repeat: a folder already moved, its saved copy intact, is left as it is; the receipt, fixed by the
 * recorded evidence, may already exist exactly as written.
 */
const removeFolders = Effect.fn("Library.setup.remove")(function* (
  operationId: OperationId,
  step: number,
  folders: readonly (FolderEvidence | LinkEvidence)[],
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const directory = recoveryDirectory(store.home, operationId, step);
  const entries = folders.map((folder, index) => ({
    folder,
    saved: recoveryEntryPath(directory, index, folder.path),
  }));
  const pending: typeof entries = [];
  for (const entry of entries) {
    const atOriginal =
      (yield* parentIsAsRecorded(entry.folder.path, entry.folder.parent)) &&
      (yield* holdsEvidence(entry.folder, entry.folder.path)) &&
      !(yield* fs.exists(entry.saved));
    if (atOriginal) {
      pending.push(entry);
      continue;
    }
    const moved =
      (yield* absentUnder(entry.folder.path, entry.folder.parent)) &&
      (yield* holdsEvidence(entry.folder, entry.saved));
    if (!moved) return differs(step, entry.folder);
  }
  for (const path of [
    removedPath(store.home),
    join(removedPath(store.home), operationId),
    directory,
  ])
    yield* recoveryContainer(path);
  const receipt = yield* Schema.encodeEffect(Receipt)({
    schemaVersion: 3,
    entries: entries.map(({ folder, saved }) => receiptEntry(folder, saved)),
  });
  const receiptPath = join(directory, "receipt.json");
  yield* writeJsonExclusive(receiptPath, receipt).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "AlreadyExists"
        ? Effect.flatMap(fs.readFileString(receiptPath), (text) =>
            text === `${JSON.stringify(receipt, null, 2)}\n` ? Effect.void : Effect.fail(error),
          )
        : Effect.fail(error),
    ),
  );
  for (const { folder, saved } of pending) {
    yield* leavePnpmSkill(folder.path);
    // Recheck just before the move: the receipt write may have taken a while.
    if (
      !(yield* parentIsAsRecorded(folder.path, folder.parent)) ||
      !(yield* holdsEvidence(folder, folder.path))
    )
      return differs(step, folder);
    yield* fs.rename(folder.path, saved);
  }
  return {
    _tag: "Ran",
    result: {
      _tag: "Remove",
      recoveryDirectory: directory,
      removed: folders.map(({ path }) => path),
    },
    after: folders.map((folder) => ({ _tag: "Absent", path: folder.path, parent: folder.parent })),
  } satisfies StepOutcome;
});

const runStep = Effect.fn("Library.setup.step")(function* (
  operationId: OperationId,
  index: number,
  step: SupportedSetupStep,
) {
  if (step._tag === "Remove") return yield* removeFolders(operationId, index, step.folders);
  const imported = yield* Effect.scoped(importCollection(step.request));
  return {
    _tag: "Ran",
    result: { _tag: "Import", imported },
    after: [{ _tag: "Retained", hash: imported.snapshotDigest }],
  } satisfies StepOutcome;
});

const isSupported = (step: SetupStep): step is SupportedSetupStep =>
  step._tag === "Import" || step._tag === "Remove";

/**
 * Run the Pending steps of the operation `operationId` records, under the writer that saved it.
 * A step that differs from its record, fails, or finds the operation gone stops the operation;
 * nothing that ran is undone.
 */
const runOperation = Effect.fn("Library.setup.run")(function* (operationId: OperationId) {
  const store = yield* LibraryStore;
  const completed: SetupStepResult[] = [];
  const stop = (reason: SetupStopReason) =>
    Effect.gen(function* () {
      const current = yield* store.load;
      yield* saveOperation(current, OperationStatus.cases.Stopped.make({ operationId, reason }));
    }).pipe(
      // Unsaved, the record stays Pending and the next run finds it.
      Effect.catchCause((cause) =>
        Effect.logWarning("Setup stopped, but could not record it", cause),
      ),
      Effect.map((): SetupResult => ({ _tag: "Stopped", operationId, completed, reason })),
    );
  const failed = (step: number) => (error: unknown) => stop({ _tag: "StepFailed", step, error });

  const loaded = yield* Effect.result(
    Effect.flatMap(store.load, (state) => operationIn(state, operationId)),
  );
  if (loaded._tag === "Failure") return yield* failed(0)(loaded.failure);
  if (Option.isNone(loaded.success) || loaded.success.value._tag !== "Pending")
    return yield* stop({
      _tag: "LibraryChanged",
      step: 0,
      revision: yield* Effect.orElseSucceed(
        Effect.map(store.inspect, (inspected) => snapshotOf(inspected).revision),
        () => snapshotOf({ present: false }).revision,
      ),
    });
  const recorded = loaded.success.value.steps;
  for (const [index, { step, status }] of recorded.entries()) {
    if (status === "Done") continue;
    if (!isSupported(step))
      return yield* failed(index)(
        new InvalidIntent({ detail: `Setup cannot run ${step._tag} steps yet` }),
      );
    const outcome = yield* Effect.result(runStep(operationId, index, step));
    if (outcome._tag === "Failure") return yield* failed(index)(outcome.failure);
    if (outcome.success._tag === "Stop") return yield* stop(outcome.success.reason);
    const { result, after } = outcome.success;
    // Mark the step Done in the state as it is now: the step itself may have saved it.
    const marked = yield* Effect.result(
      Effect.gen(function* () {
        const current = yield* store.load;
        const operation = yield* operationIn(current, operationId);
        if (Option.isNone(operation) || operation.value._tag !== "Pending")
          return Option.some(snapshotOf({ present: true, state: current }).revision);
        yield* saveOperation(
          current,
          OperationStatus.cases.Pending.make({
            operationId,
            steps: operation.value.steps.map((saved, at) =>
              at === index ? { ...saved, after, status: "Done" } : saved,
            ),
          }),
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
    Effect.flatMap(store.load, (current) =>
      saveOperation(current, OperationStatus.cases.Done.make({ operationId })),
    ),
  );
  if (finished._tag === "Failure") return yield* failed(recorded.length - 1)(finished.failure);
  return {
    _tag: "Done",
    operationId,
    steps: completed,
    warnings: [],
    recoveryDirectories: completed.flatMap((step) =>
      step._tag === "Remove" ? [step.recoveryDirectory] : [],
    ),
  } satisfies SetupResult;
});

/**
 * Save the steps as one Pending operation, then run them. Refuses with `StalePlan` unless the
 * Library is still `base`. A later setup replaces the records of earlier Done ones; Pending and
 * Stopped records stay until undone.
 */
export const setup = Effect.fn("Library.setup")(function* (
  steps: readonly SupportedSetupStep[],
  options: { readonly base: Snapshot },
) {
  const store = yield* LibraryStore;
  const invalid = checkSteps(store.home, steps);
  if (Option.isSome(invalid)) return yield* new InvalidIntent({ detail: invalid.value });
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const inspected = yield* store.inspect;
      const actual = snapshotOf(inspected).revision;
      if (actual !== options.base.revision)
        return yield* new StalePlan({
          message: "The Library changed after setup was reviewed",
          expected: options.base.revision,
          actual,
        });
      const state = inspected.present ? inspected.state : emptyLibraryState();
      const operationId = makeOperationId();
      const pending = yield* encodeOperation(
        OperationStatus.cases.Pending.make({ operationId, steps: steps.map(recordedStep) }),
      ).pipe(
        Effect.mapError(
          () => new InvalidLibraryState({ path: store.statePath, detail: "invalid setup record" }),
        ),
      );
      yield* store.save(
        {
          ...state,
          operations: [
            ...state.operations.filter((operation) => operation._tag !== "Done"),
            pending,
          ],
        },
        state,
      );
      return yield* runOperation(operationId);
    }),
  );
});

/**
 * Run what remains of a Pending operation, as after a crash: a step whose effect is complete is
 * skipped, one still as recorded runs, and anything else stops the operation. An operation that
 * is not Pending is returned as recorded.
 */
export const resumeSetup = Effect.fn("Library.resumeSetup")(function* (operationId: OperationId) {
  const store = yield* LibraryStore;
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const operation = yield* Effect.flatMap(store.load, (state) =>
        operationIn(state, operationId).pipe(
          Effect.mapError(
            () =>
              new InvalidLibraryState({ path: store.statePath, detail: "invalid setup record" }),
          ),
        ),
      );
      if (Option.isNone(operation))
        return yield* new InvalidIntent({ detail: `No setup is recorded as ${operationId}` });
      switch (operation.value._tag) {
        case "Pending":
          return yield* runOperation(operationId);
        case "Done":
          return {
            _tag: "Done",
            operationId,
            steps: [],
            warnings: [],
            recoveryDirectories: [],
          } satisfies SetupResult;
        case "Stopped":
          return {
            _tag: "Stopped",
            operationId,
            completed: [],
            reason: operation.value.reason,
          } satisfies SetupResult;
      }
    }),
  );
});
