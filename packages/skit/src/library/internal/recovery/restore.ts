import { Effect } from "effect";
import type { Snapshot } from "../../snapshot.js";

import { planningState, applyReviewed } from "../../reviewed-plan.js";
import { captureRecoveryRestore, inspectRecoveryOperation } from "./moves.js";
import { RecoveryInvalid } from "./evidence.js";
import { setupOperation } from "../../setup.js";
import { makeOperationId } from "../../entity-ids.js";

export interface RestoreIntent {
  readonly _tag: "Restore";
  readonly operationId: string;
}
export const planRestore = Effect.fn("Library.planRestore")(function* (
  home: string,
  intent: RestoreIntent,
  options: { readonly base: Snapshot },
) {
  yield* planningState(home, options.base);
  const program = yield* captureRecoveryRestore(home, intent.operationId);
  return {
    _tag: "Restore" as const,
    intent,
    baseRevision: options.base.revision,
    planId: program.summary.planId,
    change: program.summary,
    program,
  };
});
export type RestorePlan = Effect.Success<ReturnType<typeof planRestore>>;
export type RestorePlanError = Effect.Error<ReturnType<typeof planRestore>>;
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
        return { _tag: "Restore" as const, result: { after, phase } };
      }),
  );
export type RestoreApplyError = Effect.Error<ReturnType<typeof applyRestore>>;
export type RestoreOutcome = Effect.Success<ReturnType<typeof applyRestore>>;
