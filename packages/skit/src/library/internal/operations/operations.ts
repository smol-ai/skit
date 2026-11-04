import { Effect, Schema } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import { InstalledSkills } from "../../installed-skills.js";
import { StalePlan, type Outcome, type Plan } from "../../library-plan.js";
import { LibraryWriter, loadLibrary } from "../../store/library-store.js";
import { OperationStatus, type StepRouting } from "../../store/state-schema.js";
import type { OperationId } from "../../entity-ids.js";
import { planIntent } from "../../plan-changes.js";
import { LibraryState } from "../../library-state.js";
import { routedInstalledSkills } from "../../routing/recorded.js";
import { apply, settleBackups } from "./apply.js";
import { prepareApply, resumeApply, reviewedApply, saveStep, type ApplyStep } from "./recorded.js";
import { applyOutcome } from "./result.js";

/** The recorded runner is the only entry to ordinary folder execution. */
export const runApply = Effect.fn("Library.recordedApplyStep")(function* (
  operationId: OperationId,
  index: number,
  step: ApplyStep,
  batch?: string,
) {
  const files = yield* routedInstalledSkills(step.routing);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const original = yield* reviewedApply(step);
      const attempt = yield* Effect.result(
        Effect.gen(function* () {
          const resumed = yield* resumeApply(operationId, index, step, batch);
          if (resumed.completed) {
            yield* settleBackups({ ...step.before, operations: [] }, [
              ...step.before.installed_skills,
              ...step.expected,
            ]);
            return { _tag: "Applied", results: [], copies: [] } satisfies Outcome;
          }
          const plan = yield* planIntent(original.intent, {
            home: (yield* LibraryWriter).home,
            base: resumed.base,
            approvals: original.approvals,
          });
          if (
            canonicalJson(plan.routes) !== canonicalJson(original.routes) ||
            plan.changes.some((change) => {
              if ("subject_id" in change) return false;
              const path = "path" in change ? change.path : change.recorded.path;
              return !original.changes.some((saved) => {
                if ("subject_id" in saved) return false;
                return (
                  ("path" in saved ? saved.path : saved.recorded.path) === path &&
                  (!("skillVersionId" in change) ||
                    ("skillVersionId" in saved &&
                      saved.skillId === change.skillId &&
                      saved.skillVersionId === change.skillVersionId))
                );
              });
            })
          )
            return yield* new StalePlan({
              message: "Recorded routing or installed-skill choices changed",
            });
          return yield* apply(plan, {
            operationId,
            step: index,
            batch,
            expected: resumed.expected,
          });
        }).pipe(
          Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
            Effect.fail(new StalePlan({ message: error.message })),
          ),
        ),
      );
      const outcome: Outcome =
        attempt._tag === "Success"
          ? attempt.success
          : { _tag: "Incomplete", results: [], reason: "update", cause: attempt.failure };
      return applyOutcome(original, yield* loadLibrary((yield* LibraryWriter).home), outcome);
    }).pipe(Effect.provideService(InstalledSkills.Service, files)),
  );
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
    const files = yield* routedInstalledSkills(latest.apply.routing);
    yield* resumeApply(operationId, index, latest.apply, latest.key).pipe(
      Effect.provideService(InstalledSkills.Service, files),
    );
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
