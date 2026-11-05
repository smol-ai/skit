import { Effect, Schema } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import * as InstalledSkills from "../../installed-skills.js";
import { StalePlan, type Plan } from "../../library-plan.js";
import { LibraryWriter, loadLibrary } from "../../store/library-store.js";
import { OperationStatus, type StepRouting } from "../../store/state-schema.js";
import type { OperationId } from "../../entity-ids.js";
import { LibraryState } from "../../library-state.js";
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
  return applyOutcome(step, yield* loadLibrary((yield* LibraryWriter).home), {
    _tag: "Incomplete",
    results: [],
    reason: "update",
    cause:
      cause._tag === "Library.InstalledSkillsChanged"
        ? new StalePlan({ message: cause.message })
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
  const savedState = yield* loadLibrary(writer.home);
  const savedOperations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
    savedState.operations,
  );
  const savedOperation = savedOperations.find((item) => item.operationId === operationId);
  const latest =
    savedOperation?._tag === "Pending" ? savedOperation.steps[index]?.applies?.at(-1) : undefined;
  if (latest) {
    const outcome = yield* runApply(operationId, index, latest.apply, latest.key);
    if (outcome._tag === "Incomplete") return yield* Effect.fail(outcome.cause);
  }
  const applyBatch = Effect.fn("Library.applyBatch")(function* (key: string, plan: Plan) {
    const state = yield* loadLibrary(writer.home);
    const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
      state.operations,
    );
    const operation = operations.find((item) => item.operationId === operationId);
    if (operation?._tag !== "Pending" || !operation.steps[index])
      return yield* new StalePlan({ message: "Installed changes require their Pending operation" });
    const prior = operation.steps[index].applies?.find((item) => item.key === key)?.apply;
    const prepared = prior ?? (yield* prepareApply(writer.home, plan, { _tag: "None" })).step;
    const step = { ...prepared, routing };
    if (!prior) yield* saveStep(operationId, index, step, key);
    return yield* runApply(operationId, index, step, key);
  }, Effect.scoped);
  const publishSync = Effect.fn("Library.saveSyncState")(function* () {
    const current = yield* loadLibrary(writer.home);
    const saved = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
      current.operations,
    );
    const operation = saved.find((item) => item.operationId === operationId);
    const step = operation?._tag === "Pending" ? operation.steps[index]?.step : undefined;
    const source =
      step?._tag === "Sync" && step.phase === "publish"
        ? operation?.steps[step.sourceStep]?.step
        : undefined;
    if (source?._tag !== "Sync" || source.phase !== "retire")
      return yield* new StalePlan({ message: "Sync state requires its recorded publication step" });
    const program = source.program;
    const { operations, ...body } = current;
    if (canonicalJson(body) === canonicalJson(program.after)) return;
    const next = yield* LibraryState.makeEffect({ ...program.after, operations });
    yield* writer.save(next, current);
  });
  return { home: writer.home, apply: applyBatch, publishSync };
}, Effect.scoped);
export type OperationScope = Effect.Success<ReturnType<typeof operationScope>>;
