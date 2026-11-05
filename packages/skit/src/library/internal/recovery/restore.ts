import { Effect, Schema } from "effect";
import { Revision } from "../../snapshot.js";
import { Hash } from "../../../vocabulary.js";
import { RecoveryInspection } from "../../recovery-facts.js";
import { RecoveryRestore } from "../../store/state-schema.js";
import type { Snapshot } from "../../snapshot.js";

import { planningState, applyReviewed } from "../../reviewed-plan.js";
import { captureRecoveryRestore, inspectRecoveryOperation } from "./moves.js";
import { RecoveryInvalid } from "./evidence.js";
import { setupOperation } from "../../setup.js";
import { makeOperationId } from "../../entity-ids.js";

export const RestoreIntent = Schema.TaggedStruct("Restore", { operationId: Schema.NonEmptyString });
export type RestoreIntent = typeof RestoreIntent.Type;
export const RestorePlan = Schema.TaggedStruct("Restore", {
  intent: RestoreIntent,
  baseRevision: Revision,
  planId: Hash,
  change: RecoveryInspection,
  program: RecoveryRestore,
});
export type RestorePlan = typeof RestorePlan.Type;
export const planRestore = Effect.fn("Library.planRestore")(function* (
  home: string,
  intent: RestoreIntent,
  options: { readonly base: Snapshot },
) {
  yield* planningState(home, options.base);
  const program = yield* captureRecoveryRestore(home, intent.operationId);
  return yield* RestorePlan.makeEffect({
    _tag: "Restore",
    intent,
    baseRevision: options.base.revision,
    planId: program.summary.planId,
    change: program.summary,
    program,
  }).pipe(Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid Restore review" })));
});
export type RestorePlanError = Effect.Error<ReturnType<typeof planRestore>>;
export interface RestoreOutcome {
  readonly _tag: "Restore";
  readonly result: {
    readonly after: typeof RecoveryInspection.Type;
    readonly phase: "restored" | "partial" | "conflicted";
  };
}
export const applyRestore = (home: string, plan: RestorePlan) =>
  applyReviewed(
    home,
    plan,
    (base) => planRestore(home, plan.intent, { base }),
    (again, base) =>
      Effect.gen(function* () {
        const result = yield* setupOperation([{ _tag: "Restore", program: again.program }], {
          base,
          operationId: makeOperationId(),
        });
        if (result._tag === "Stopped")
          return yield* new RecoveryInvalid({
            detail: "Recorded restore stopped; inspect its saved entries before retrying",
          });
        const after = yield* inspectRecoveryOperation(home, again.intent.operationId);
        const phase = after.entries.every((entry) => entry.status === "at-original")
          ? ("restored" as const)
          : after.entries.some((entry) => entry.status === "at-original")
            ? ("partial" as const)
            : ("conflicted" as const);
        const outcome: RestoreOutcome = { _tag: "Restore", result: { after, phase } };
        return outcome;
      }),
  );
export type RestoreApplyError = Effect.Error<ReturnType<typeof applyRestore>>;
