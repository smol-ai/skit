import { Effect } from "effect";

import { RecoveryInvalid } from "../store/operation-failures.js";
import { Service } from "../service.js";
import { StalePlan } from "../library-plan.js";

/** Review one Library Undo through its owner; apply only the reviewed plan. */
export const prepareSetupUndo = Effect.fn("SetupUndo.prepare")(function* (operationId: string) {
  const library = yield* Service;
  const plan = yield* library.plan({ _tag: "Undo", operationId }, { base: yield* library.read });
  const { next: _next, ...summary } = plan.change;
  const conflicts = summary.conflicts;
  return {
    summary,
    apply: () =>
      Effect.gen(function* () {
        if (conflicts.length)
          return yield* new RecoveryInvalid({ reason: { _tag: "Conflicts", conflicts } });
        const owner = yield* Service;
        const undone = yield* owner.apply({ _tag: "Apply", plan: plan }).pipe(
          Effect.map((outcome) => outcome.result),
          Effect.catchTag("Library.StalePlan", () =>
            Effect.fail(new StalePlan({ reason: { _tag: "ReviewedStateChanged" } })),
          ),
        );
        if (undone._tag === "Undone")
          return { ...summary, status: "undone" as const, backupId: undone.backupId };
        return {
          ...summary,
          status: "already-undone" as const,
        };
      }),
  };
});
