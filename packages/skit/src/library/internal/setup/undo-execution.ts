import { basename, dirname, join, relative } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import { copyLocalTree } from "../../../platform/copy-tree.js";
import { LinkStat } from "../../../platform/link-stat.js";
import { prepareInstalledSkillRebuild } from "../../installation/retained-skill.js";
import { originalTreeHash } from "../../collection-version.js";
import { globalEnabled } from "../../enabled.js";
import { holdsEvidence, parentIsAsRecorded, recoveryEntryPath } from "../../folder-evidence.js";
import { LibraryState } from "../../library-state.js";
import { StalePlan } from "../../library-plan.js";
import { moveAside } from "./moves.js";
import { LibraryWriter, libraryOriginalsPath, loadLibrary } from "../../store/library-store.js";
import { OperationStatus, type UndoProgram } from "../../store/state-schema.js";
import type { OperationId } from "../../entity-ids.js";
import { ensureRecoveryOperation } from "../recovery/moves.js";
import { RecoveryInvalid } from "../../recovery-facts.js";
import { readSkillPathDetails } from "./undo-evidence.js";
import { checkSetupGlobalContent } from "./protection.js";
import { checkAnchor, restoreMarker } from "./undo-files.js";
import type { UndoPath, UndoAction } from "./undo-evidence.js";

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** Execute only the persisted inverse; observed files never choose new actions on replay. */
export const runUndo = Effect.fn("Library.runUndo")(function* (
  operationId: OperationId,
  index: number,
  recorded: UndoProgram,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const writer = yield* LibraryWriter;
  const home = writer.home;
  let program = recorded;
  const directory = join(home, "removed", program.backupId, "step-1");
  const save = Effect.fn("Library.saveUndoProgress")(function* (next: UndoProgram) {
    const state = yield* loadLibrary(home);
    const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
      state.operations,
    );
    const operation = operations.find((item) => item.operationId === operationId);
    if (operation?._tag !== "Pending" || operation.steps[index]?.step._tag !== "Undo")
      return yield* new StalePlan({ message: "Undo requires its Pending operation" });
    const changed = {
      ...operation,
      steps: operation.steps.map((step, at) =>
        at === index ? { ...step, step: { _tag: "Undo" as const, program: next } } : step,
      ),
    };
    const encoded = yield* Schema.encodeEffect(OperationStatus)(changed);
    yield* writer.save(
      {
        ...state,
        operations: state.operations.map((item) =>
          item.operationId === operationId ? encoded : item,
        ),
      },
      state,
    );
    program = next;
  });
  const publication = Effect.fn("Library.checkUndoPublication")(function* () {
    const state = yield* loadLibrary(home);
    const { operations: _operations, ...body } = state;
    if (!equal(body, program.before) && !equal(body, program.after))
      return yield* new StalePlan({ message: "Library state differs from the recorded Undo" });
    return state;
  });
  const isAfter = (action: UndoAction, actual: UndoPath) =>
    action.after !== undefined && equal(actual, action.after);
  const preserved = Effect.fn("Library.checkUndoPreservation")(function* (path: string) {
    const at = program.preserve.findIndex((item) => item.path === path);
    const folder = program.preserve[at];
    return (
      folder !== undefined && (yield* holdsEvidence(folder, recoveryEntryPath(directory, at, path)))
    );
  });
  // Recorded lexical aliases share one destination, but each keeps its own checked parent.
  const coordinate = (path: UndoPath) =>
    join(path.anchor.physicalPath, relative(path.anchor.path, path.path));
  const actionAt = (path: UndoPath) =>
    program.actions.find((action) => {
      const before = program.paths.find((item) => item.path === action.path);
      return before !== undefined && coordinate(before) === coordinate(path);
    });
  const check = Effect.fn("Library.checkUndoFiles")(function* () {
    yield* publication();
    for (const source of program.sourceImports)
      if ((yield* originalTreeHash(source.path)) !== source.hash)
        return yield* new RecoveryInvalid({ detail: `Undo source changed: ${source.path}` });
    for (const before of program.paths) {
      const action = actionAt(before);
      const actual = yield* readSkillPathDetails(before.path);
      if (action) {
        const file = program.files.find((item) => item.path === before.path);
        if (!file) return yield* new RecoveryInvalid({ detail: "Missing Undo file evidence" });
        yield* checkAnchor(file);
        yield* checkSetupGlobalContent(file.path);
        if (
          action.after &&
          equal(actual, { ...action.after, path: before.path, anchor: before.anchor })
        )
          continue;
        if (
          actual.entry === null &&
          (yield* preserved(before.path)) &&
          (yield* parentIsAsRecorded(before.path, {
            path: before.anchor.physicalPath,
            dev: before.anchor.dev,
            ino: before.anchor.ino,
          }))
        )
          continue;
      }
      if (!equal(actual, before))
        return yield* new StalePlan({ message: `Undo evidence changed at ${before.path}` });
    }
    for (const source of program.sources) {
      const actual = yield* readSkillPathDetails(source.path);
      const moved = program.actions.find(
        (action) => action.source === source.path && action.transfer === "move",
      );
      if (moved && isAfter(moved, yield* readSkillPathDetails(moved.path))) {
        if (actual.entry === null && equal(actual.anchor, source.anchor)) continue;
        return yield* new StalePlan({
          message: `Restored Undo source is occupied: ${source.path}`,
        });
      }
      if (!equal(actual, source))
        return yield* new StalePlan({ message: `Undo source changed at ${source.path}` });
    }
    for (const action of program.actions)
      if (
        action.staged &&
        !isAfter(action, yield* readSkillPathDetails(action.path)) &&
        !equal(yield* readSkillPathDetails(action.staged.path), action.staged)
      )
        return yield* new StalePlan({ message: `Undo staging changed: ${action.path}` });
    if (program.preserved)
      for (const file of program.preserve)
        if (!(yield* preserved(file.path)))
          return yield* new RecoveryInvalid({ detail: `Undo recovery copy changed: ${file.path}` });
  });
  // Bind postimages before any live destination mutation. Copy/rebuild staging lives beside the
  // destination, so publication is an atomic rename even when the Library is on another device.
  yield* check();
  for (const [at, action] of program.actions.entries()) {
    if (action.after) continue;
    const file = program.files.find((item) => item.path === action.path);
    const before = program.paths.find((item) => item.path === action.path);
    if (!file || !before)
      return yield* new RecoveryInvalid({ detail: "Missing Undo action evidence" });
    let after: UndoPath;
    let staged: UndoPath | undefined;
    if (action.kind === "remove-created") after = { ...before, entry: null };
    else if (action.kind === "release-ownership") {
      if (!file.entry || !before.entry)
        return yield* new RecoveryInvalid({ detail: "Missing ownership evidence" });
      after = {
        ...before,
        entry: {
          ...before.entry,
          hash: file.entry.hash,
          marker: file.entry.marker,
          markerType: file.entry.marker === null ? null : "File",
          markerMode: file.entry.marker === null ? null : file.entry.markerMode,
        },
      };
    } else if (action.transfer === "move") {
      const source = program.sources.find((item) => item.path === action.source);
      if (!source?.entry)
        return yield* new RecoveryInvalid({ detail: "Missing original source evidence" });
      after = { ...source, path: action.path, anchor: before.anchor };
    } else {
      if (!file.entry || !action.source)
        return yield* new RecoveryInvalid({ detail: "Missing reconstruction evidence" });
      const staging = join(dirname(action.path), `.skit-undo-${operationId}-${at + 1}`);
      if (!(yield* fs.exists(staging))) yield* fs.makeDirectory(staging, { mode: 0o700 });
      if ((yield* links.identity.lstat(staging)).type !== "Directory")
        return yield* new RecoveryInvalid({ detail: `Redirected Undo staging: ${staging}` });
      const path = join(staging, basename(action.path));
      if (!(yield* fs.exists(path))) {
        if (action.transfer === "rebuild") {
          const prior = program.after.installed_skills.find((item) => item.path === action.path);
          if (!prior) return yield* new RecoveryInvalid({ detail: "Missing reconstruction owner" });
          const state = { ...program.after, operations: [] };
          const policy = globalEnabled(state).invocation_policies?.[prior.skill_id];
          const rebuild = yield* prepareInstalledSkillRebuild(
            state,
            libraryOriginalsPath(home),
            prior,
            policy === undefined ? { source: "declared" } : { source: "override", policy },
          );
          if (rebuild.collectionVersionPath !== action.source)
            return yield* new RecoveryInvalid({ detail: "Undo reconstruction source changed" });
          yield* rebuild.build(path);
        } else yield* copyLocalTree(action.source, path, undefined, true);
        if (file.entry.type === "Directory") yield* restoreMarker(path, file.entry);
      }
      staged = yield* readSkillPathDetails(path);
      if (staged.entry?.hash !== file.entry.hash)
        return yield* new RecoveryInvalid({
          detail: `Reconstruction differs from original: ${file.path}`,
        });
      after = { ...staged, path: action.path, anchor: before.anchor };
    }
    yield* save({
      ...program,
      actions: program.actions.map((item, i) =>
        i === at ? { ...item, after, ...(staged ? { staged } : {}) } : item,
      ),
    });
  }
  yield* check();
  if (!program.preserved) {
    yield* ensureRecoveryOperation(home, join(home, "removed", program.backupId));
    const moved = yield* moveAside(operationId, directory, program.preserve);
    if (moved._tag === "Differs")
      return yield* new StalePlan({ message: `Undo successor changed: ${moved.folder.path}` });
    yield* save({ ...program, preserved: true });
  }
  for (const action of program.actions) {
    yield* check();
    if (isAfter(action, yield* readSkillPathDetails(action.path))) continue;
    const file = program.files.find((item) => item.path === action.path);
    if (!file) return yield* new RecoveryInvalid({ detail: "Missing Undo file" });
    if (action.kind === "release-ownership") {
      if (!file.entry) return yield* new RecoveryInvalid({ detail: "Missing original marker" });
      yield* restoreMarker(action.path, file.entry);
    } else if (action.kind === "restore") {
      if ((yield* readSkillPathDetails(action.path)).entry !== null)
        return yield* new StalePlan({ message: `Undo destination occupied: ${action.path}` });
      const source = action.transfer === "move" ? action.source : action.staged?.path;
      const expected =
        action.transfer === "move"
          ? program.sources.find((item) => item.path === source)
          : action.staged;
      if (!source || !expected || !equal(yield* readSkillPathDetails(source), expected))
        return yield* new StalePlan({ message: `Undo source changed: ${source}` });
      yield* fs.rename(source, action.path);
    }
    if (!isAfter(action, yield* readSkillPathDetails(action.path)))
      return yield* new RecoveryInvalid({
        detail: `Original restoration incomplete: ${action.path}`,
      });
  }
  yield* check();
  const current = yield* publication();
  const { operations, ...body } = current;
  if (!equal(body, program.after)) {
    const next = yield* LibraryState.makeEffect({ ...program.after, operations });
    yield* writer.save(next, current);
  }
  for (const action of program.actions) {
    if (!action.staged) continue;
    const parent = action.staged.anchor;
    if (!(yield* fs.exists(parent.path))) continue;
    const identity = yield* links.identity.lstat(parent.path);
    if (
      identity.type === "Directory" &&
      identity.dev === parent.dev &&
      identity.ino === parent.ino &&
      (yield* fs.readDirectory(parent.path)).length === 0
    )
      yield* fs.remove(parent.path, { recursive: true });
  }
});
