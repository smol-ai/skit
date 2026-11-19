import { prepareLibrarySide } from "../../store/difference.js";
import {
  libraryStatePath,
  loadOperation,
  LibraryWriter,
  loadLibrary,
  inspectLocalLibraryState,
} from "../../store/library-store.js";
import { Option, Effect } from "effect";

import { canonicalJson } from "../../../shared/json.js";
import * as InstalledSkills from "../../installed-skills.js";
import { StalePlan, type Plan } from "../../library-plan.js";

import { type StepRouting } from "../../store/state-schema.js";
import type { OperationId } from "../../entity-ids.js";
import { routedInstalledSkills } from "../../routing/recorded.js";
import { apply, checkApply } from "./apply.js";
import { prepareApply, saveStep, type ApplyStep } from "./recorded.js";
import { applyOutcome } from "./result.js";

/** The only execution entry consumes the durable program, never a reviewed Plan. */
export const runApply = Effect.fn("Library.recordedApplyStep")(function* (
  operationId: OperationId,
  index: number,
  step: ApplyStep,
  batch?: string,
) {
  const files = yield* routedInstalledSkills(step.routing);
  // Divergence stays typed for setup/Sync to report EvidenceDiffers.
  yield* checkApply(step).pipe(Effect.provideService(InstalledSkills.Service, files));
  const attempt = yield* Effect.result(
    apply(step, operationId, index, batch).pipe(
      Effect.provideService(InstalledSkills.Service, files),
    ),
  );
  if (attempt._tag === "Success") return attempt.success;
  const failure = attempt.failure;
  const cause = failure._tag === "Library.InstalledChangeFailed" ? failure.cause : failure;
  const path =
    failure._tag === "Library.InstalledChangeFailed"
      ? failure.path
      : cause._tag === "Library.InstalledSkillsChanged"
        ? cause.path
        : undefined;
  return yield* applyOutcome(step, yield* loadLibrary((yield* LibraryWriter).home), {
    _tag: "Incomplete",
    results: [],
    reason: "update",
    cause:
      cause._tag === "Library.InstalledSkillsChanged"
        ? new StalePlan({
            reason: { _tag: "EvidenceChanged", path: cause.path, kind: "installed" },
          })
        : cause,
    failedPaths: path === undefined ? null : [path],
  });
});

/** A batch is named by domain identity, never by the number of calls reached on replay. */
export const operationScope = Effect.fn("Library.operationScope")(function* (
  operationId: OperationId,
  index: number,
  routing: StepRouting,
) {
  const writer = yield* LibraryWriter;
  const savedOperation = Option.getOrUndefined(yield* loadOperation(writer.home, operationId));
  const latest =
    savedOperation?._tag === "Pending" ? savedOperation.steps[index]?.applies?.at(-1) : undefined;
  if (latest) {
    const outcome = yield* runApply(operationId, index, latest.apply, latest.key);
    if (outcome._tag === "Incomplete") return yield* outcome.cause;
  }
  const applyBatch = Effect.fn("Library.applyBatch")(function* (key: string, plan: Plan) {
    const operation = Option.getOrUndefined(yield* loadOperation(writer.home, operationId));
    if (operation?._tag !== "Pending" || !operation.steps[index])
      return yield* new StalePlan({ reason: { _tag: "OperationMissing", kind: "install" } });
    const prior = operation.steps[index].applies?.find((item) => item.key === key)?.apply;
    const prepared = prior ?? (yield* prepareApply(writer.home, plan, routing)).step;
    const step = { ...prepared, routing };
    if (!prior) yield* saveStep(operationId, index, step, key);
    return yield* runApply(operationId, index, step, key);
  }, Effect.scoped);
  const publishSync = Effect.fn("Library.saveSyncState")(function* () {
    const snapshot = yield* inspectLocalLibraryState(writer.home);
    if (!snapshot.present) return yield* new StalePlan({ reason: { _tag: "LibraryChanged" } });
    const current = snapshot.state;
    const operation = Option.getOrUndefined(yield* loadOperation(writer.home, operationId));
    const step = operation?._tag === "Pending" ? operation.steps[index]?.step : undefined;
    const source =
      operation?._tag === "Pending" && step?._tag === "Sync" && step.phase === "publish"
        ? operation.steps[step.sourceStep]?.step
        : undefined;
    if (source?._tag !== "Sync" || source.phase !== "retire")
      return yield* new StalePlan({
        reason: { _tag: "OperationMissing", kind: "sync-publication" },
      });
    const program = source.program;
    const after = yield* prepareLibrarySide(
      program.difference,
      current,
      "after",
      libraryStatePath(writer.home),
    ).pipe(
      Effect.mapError(() => new InstalledSkills.Changed({ path: libraryStatePath(writer.home) })),
    );
    if (canonicalJson(current) === canonicalJson(after)) return;
    yield* writer.save(after, current, snapshot.revision);
  });
  const uninstallCopies = Effect.fn("Library.uninstallSyncCopies")(function* () {
    const operation = Option.getOrUndefined(yield* loadOperation(writer.home, operationId));
    const step = operation?._tag === "Pending" ? operation.steps[index]?.step : undefined;
    if (step?._tag !== "Sync" || step.phase !== "retire" || step.program.save !== "before")
      return yield* new StalePlan({ reason: { _tag: "PlanInvalid", kind: "intent" } });
    const files = yield* InstalledSkills.Service;
    let uninstalled = 0;
    // Live rows may already omit these copies. The recorded program owns their authority.
    for (const copy of step.program.retire) {
      const current = yield* files.inspect(copy.path);
      const saved = step.program.folders.find((folder) => folder.path === copy.path);
      if (!saved) return yield* new InstalledSkills.Changed({ path: copy.path });
      if (canonicalJson(current.ancestors) !== canonicalJson(saved.ancestors))
        return yield* new InstalledSkills.Changed({ path: copy.path });
      if (current.entry._tag === "Absent") {
        if (saved.entry === "Absent") continue;
        let backedUp = false;
        for (const backup of yield* files.backups.scan(copy.root, copy.installed_skill_id))
          if ((yield* files.inspect(backup.path)).evidence === saved.evidence) {
            backedUp = true;
            break;
          }
        if (!backedUp) return yield* new InstalledSkills.Changed({ path: copy.path });
      } else {
        if (current.evidence !== saved.evidence)
          return yield* new InstalledSkills.Changed({ path: copy.path });
        yield* files.uninstall(copy.root, copy.path, copy.installed_skill_id);
      }
      uninstalled++;
    }
    return uninstalled;
  });
  return { home: writer.home, apply: applyBatch, publishSync, uninstallCopies };
}, Effect.scoped);
export type OperationScope = Effect.Success<ReturnType<typeof operationScope>>;
