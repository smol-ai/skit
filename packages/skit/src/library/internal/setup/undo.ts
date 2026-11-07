import { setupOperation } from "./run.js";
import { snapshotOf, type Snapshot } from "../../snapshot.js";
import { StalePlan } from "../../library-plan.js";
import { UndoPlan, type UndoIntent, type UndoResult } from "./undo-plan.js";
import {
  OperationStatus,
  type UndoProgram,
  type FolderEvidence,
  type LinkEvidence,
  type AbsentEvidence,
} from "../../store/state-schema.js";
import { basename, dirname } from "node:path";
import { Effect, Option, Schema } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import { hashParts } from "../../../artifact/descriptor.js";
import { emptyLibraryState, libraryStateRevision } from "../../library-state.js";
import {
  libraryOriginalsPath,
  writeLibrary,
  inspectLocalLibraryState,
} from "../../store/library-store.js";
import { LinkStat } from "../../../platform/link-stat.js";
import { setupIntent, type SetupIntent } from "./intent.js";
import { sourceImports } from "../../library-contracts.js";
import { makeOperationId, type CollectionId } from "../../entity-ids.js";
import * as MachineSettings from "../../machine-settings.js";
import { recoveryOperationDirectory } from "../recovery/moves.js";
import { RecoveryInvalid } from "../../recovery-facts.js";
import {
  planUndoFiles,
  installedSkillChoice,
  type SetupChanges,
  type UndoFile,
} from "./undo-files.js";
import { prepareSetupSourceUndo, type UndoSourceImport } from "./undo-sources.js";
import { reverseSetupIntent } from "./undo-intent.js";

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** A setup as undo reads it: what it changed, and its record, which the undo plan covers. */
interface SetupRecord extends SetupChanges {
  readonly before: SetupIntent;
  readonly after: SetupIntent;
  readonly conflicts: readonly string[];
  readonly evidence: unknown;
}

/**
 * The nearest folder above `path` whose physical path is `parent`: the physical parent, or, when
 * setup created the folders between, the folder it recorded instead.
 */
const anchorOf = Effect.fn("SetupUndo.anchorOf")(function* (
  path: string,
  parent: { readonly path: string; readonly dev: bigint; readonly ino: bigint },
) {
  const links = yield* LinkStat;
  let candidate = dirname(path);
  for (;;) {
    const physical = yield* links.realPathNative(candidate).pipe(Effect.option);
    if (Option.isSome(physical) && physical.value === parent.path) break;
    if (dirname(candidate) === candidate) {
      candidate = dirname(path);
      break;
    }
    candidate = dirname(candidate);
  }
  return { path: candidate, physicalPath: parent.path, dev: parent.dev, ino: parent.ino };
});

/** What a step recorded at one path, as undo reads it. */
const setupFile = Effect.fn("SetupUndo.setupFile")(function* (
  evidence: FolderEvidence | LinkEvidence | AbsentEvidence,
) {
  const anchor = yield* anchorOf(evidence.path, evidence.parent);
  const entry: UndoFile["entry"] =
    evidence._tag === "Absent"
      ? null
      : evidence._tag === "SymbolicLink"
        ? {
            dev: evidence.dev,
            ino: evidence.ino,
            type: "SymbolicLink",
            hash: evidence.contentHash,
            unmarked: { by: "fingerprint", hash: evidence.contentHash },
            marker: null,
            linkTarget: evidence.linkTarget,
          }
        : {
            dev: evidence.dev,
            ino: evidence.ino,
            type: "Directory",
            hash: evidence.contentHash,
            unmarked: { by: "tree", hash: evidence.treeHash },
            marker: Option.getOrNull(evidence.marker),
            // SKIT writes its marker owner-only (install/files.ts).
            markerType: Option.isSome(evidence.marker) ? "File" : null,
            markerMode: Option.isSome(evidence.marker) ? 0o100600 : null,
            linkTarget: null,
          };
  return { path: evidence.path, anchor, entry } satisfies UndoFile;
});

/** A setup recorded in state.json: its steps' evidence and what it held before and after. */
const recordedSetup = Effect.fn("SetupUndo.recordedSetup")(function* (operation: OperationStatus) {
  const after = operation._tag === "Pending" ? operation.before : operation.after;
  const evidence = operation.steps.flatMap(({ before }) =>
    before.flatMap((item) => (item._tag === "Retained" ? [] : [item])),
  );
  const files: UndoFile[] = [];
  for (const item of evidence)
    if (!files.some((file) => file.path === item.path)) files.push(yield* setupFile(item));
  return {
    before: operation.before.intent,
    after: after.intent,
    installedSkillsBefore: operation.before.installedSkills,
    installedSkillsAfter: after.installedSkills,
    files,
    // The Done or Stopped write recorded every copy the setup's steps installed.
    claimedPaths: new Set(
      after.installedSkills
        .filter(
          (copy) =>
            copy.status === "installed" &&
            !equal(
              copy,
              operation.before.installedSkills.find(
                (item) => item.installed_skill_id === copy.installed_skill_id,
              ),
            ),
        )
        .map((copy) => copy.path),
    ),
    conflicts: operation.steps.some(({ step }) => step._tag === "Restore" || step._tag === "Undo")
      ? ["Recovery Restore and Undo records cannot themselves be undone by setup undo."]
      : operation.steps.some(({ step }) => step._tag === "Apply")
        ? [
            "Recorded Library changes support startup recovery; use the corresponding Library command to change them.",
          ]
        : operation.steps.some(({ step }) => step._tag === "Sync")
          ? [
              "Sync records support startup recovery. Undo cannot reverse their remote publication; review bindings and sync again.",
            ]
          : operation._tag === "Pending"
            ? ["Setup has not finished. Run any SKIT command to finish or stop it, then undo it."]
            : [],
    evidence: yield* Schema.encodeEffect(OperationStatus)(operation).pipe(
      Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid recorded setup evidence" })),
    ),
  } satisfies SetupRecord;
});

const readUndo = Effect.fn("SetupUndo.read")(function* (
  home: string,
  operationId: string,
  undoSourceImports: Map<CollectionId, UndoSourceImport>,
) {
  const inspected = yield* inspectLocalLibraryState(home);
  const baseRevision = snapshotOf(inspected).revision;
  const state = inspected.present ? inspected.state : emptyLibraryState();
  const operations = yield* Schema.decodeEffect(Schema.Array(OperationStatus))(
    state.operations,
  ).pipe(Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid setup record" })));
  const recorded = operations.find((operation) => operation.operationId === operationId);
  if (!/^[a-zA-Z0-9_-]+$/.test(operationId))
    return yield* new RecoveryInvalid({ detail: "Invalid operation identifier" });
  if (recorded === undefined)
    return yield* new RecoveryInvalid({
      detail: `Setup ${operationId} has no undo record: a later setup replaced it`,
    });
  const setup = yield* recordedSetup(recorded);
  const priorBackups: string[] = [];
  const undoRecords = operations.flatMap((operation) =>
    operation.steps.flatMap(({ step }) =>
      step._tag === "Undo" && step.program.operationId === operationId
        ? [{ operation, program: step.program }]
        : [],
    ),
  );
  priorBackups.push(...undoRecords.map((item) => item.program.backupId));
  const done = undoRecords.some((item) => item.operation._tag === "Done");
  // Only identity is needed for a new source-import observation. Settings undo stays with its owner.
  const machineId = (yield* MachineSettings.read(home)).machineId;
  const conflicts: string[] = [...setup.conflicts];
  const sources = done
    ? { conflicts: [], evidence: [], restorations: [] }
    : yield* prepareSetupSourceUndo(
        state,
        setup.before,
        setup.after,
        libraryOriginalsPath(home),
        machineId,
        undoSourceImports,
      );
  const intent = reverseSetupIntent(state, setup.before, setup.after, sources.restorations);
  conflicts.push(...sources.conflicts, ...intent.conflicts);
  const files = done
    ? undefined
    : yield* planUndoFiles(home, operationId, setup, state, priorBackups, intent.state);
  if (files) conflicts.push(...files.conflicts);
  const nextInstalledSkills = structuredClone(intent.state.installed_skills);
  for (const path of files?.affected ?? []) {
    const prior = setup.installedSkillsBefore.find((item) => item.path === path);
    const current = nextInstalledSkills.find((item) => item.path === path);
    if (equal(installedSkillChoice(prior), installedSkillChoice(current))) continue;
    const index = nextInstalledSkills.findIndex((item) => item.path === path);
    if (index >= 0) nextInstalledSkills.splice(index, 1);
    if (prior) nextInstalledSkills.push(structuredClone(prior));
  }
  const next = { ...intent.state, installed_skills: nextInstalledSkills };
  const planId = hashParts([
    canonicalJson({
      saved: setup.evidence,
      revision: libraryStateRevision(state),
      machineId,
      sources: sources.evidence,
      files: files && {
        pathDetails: files.pathDetails,
        sources: files.sourceEvidence,
        actions: files.actions,
      },
      conflicts,
    }),
  ]);
  return {
    summary: {
      operationId,
      planId,
      status: done
        ? ("already-undone" as const)
        : conflicts.length
          ? ("conflicted" as const)
          : ("ready" as const),
      conflicts: done ? [] : conflicts,
      files: done ? [] : files!.actions.map(({ path, kind }) => ({ path, kind })),
      sourceSelections: sources.restorations.map((restored) => ({
        collectionId: restored.collection_id,
        label: state.collections.find((item) => item.collection_id === restored.collection_id)!
          .label,
        fromSnapshot: state.collection_versions.find(
          (item) =>
            item.collection_version_id ===
            sourceImports(state, restored.collection_id)[0].collection_version_id,
        )!.hash,
        toSnapshot: state.collection_versions.find(
          (item) => item.collection_version_id === restored.collection_version_id,
        )!.hash,
      })),
      intentChanged: !done && !equal(setupIntent(state), setupIntent(next)),
    },
    setup,
    state,
    baseRevision,
    snapshot: snapshotOf(inspected),
    next: done ? state : next,
    files,
    sourceImports: sources.evidence,
  };
});

/** Public review data assembled from this read; filesystem actions remain private. */
const planOf = (
  current: Effect.Success<ReturnType<typeof readUndo>>,
  backupId: string,
  observations: Map<CollectionId, UndoSourceImport>,
) =>
  UndoPlan.make({
    _tag: "Undo",
    intent: { _tag: "Undo", operationId: current.summary.operationId },
    baseRevision: current.baseRevision,
    planId: current.summary.planId,
    backupId,
    observations: [...observations].map(([collectionId, value]) => ({ collectionId, ...value })),
    change: { ...current.summary, next: current.next },
  });

/** Preview against exactly the Library the caller displayed. No writer is acquired. */
export const planUndo = Effect.fn("Library.planUndo")(function* (
  home: string,
  intent: UndoIntent,
  options: { readonly base: Snapshot },
) {
  const backupDirectory = recoveryOperationDirectory(home);
  const observations = new Map<CollectionId, UndoSourceImport>();
  const current = yield* readUndo(home, intent.operationId, observations);
  if (current.baseRevision !== options.base.revision)
    return yield* new StalePlan({ message: "The Library changed after undo was reviewed" });
  return planOf(current, basename(backupDirectory), observations);
}, Effect.scoped);

/** Recompute the review under the writer, record the inverse, restore files, then publish it. */
export const applyUndo = Effect.fn("Library.applyUndo")(function* (home: string, input: UndoPlan) {
  const approved = yield* Schema.decodeEffect(UndoPlan)(structuredClone(input)).pipe(
    Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid undo plan" })),
  );
  const observations = new Map<CollectionId, UndoSourceImport>(
    approved.observations.map(({ collectionId, ...value }) => [collectionId, value]),
  );
  return yield* writeLibrary(
    home,
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* readUndo(home, approved.intent.operationId, observations);
        if (!equal(planOf(current, approved.backupId, observations), approved))
          return yield* new StalePlan({ message: "Undo evidence changed after it was reviewed" });
        const change = { ...current.summary, next: current.next };
        if (current.summary.status === "already-undone")
          return { _tag: "AlreadyUndone", change } satisfies UndoResult;
        if (current.summary.conflicts.length)
          return yield* new RecoveryInvalid({ detail: current.summary.conflicts.join("; ") });
        if (!current.files)
          return yield* new RecoveryInvalid({ detail: "Missing reviewed Undo files" });
        const { operations: _beforeOperations, ...before } = current.state;
        const { operations: _afterOperations, ...after } = current.next;
        const program: UndoProgram = {
          operationId: approved.intent.operationId,
          backupId: approved.backupId,
          before,
          after,
          files: current.setup.files,
          paths: current.files.pathDetails,
          sources: current.files.sourceEvidence,
          sourceImports: current.sourceImports,
          actions: current.files.actions,
          preserve: current.files.preserve,
          preserved: false,
        };
        const result = yield* setupOperation([{ _tag: "Undo", program }], {
          base: current.snapshot,
          operationId: makeOperationId(),
          replaceDone: false,
        });
        if (result._tag === "Stopped")
          return yield* new RecoveryInvalid({
            detail: `Recorded Undo ${result.operationId} stopped: ${result.reason._tag === "StepFailed" ? result.reason.error.message : result.reason._tag}. Review Library history before trying again`,
          });
        return { _tag: "Undone", change, backupId: approved.backupId } satisfies UndoResult;
      }),
    ),
  );
});
export type UndoPlanError = Effect.Error<ReturnType<typeof planUndo>>;
export type UndoApplyError = Effect.Error<ReturnType<typeof applyUndo>>;
