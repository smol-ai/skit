import { Effect } from "effect";
import { canonicalJson } from "../../shared/json.js";
import { hashParts } from "../../artifact/descriptor.js";
import * as MachineSettings from "../machine-settings.js";
import { RecoveryInvalid } from "../store/operation-failures.js";
import { Service } from "../service.js";
import { StalePlan } from "../library-plan.js";

/** A combined review of two independently durable owner operations. No store or writer is opened. */
export const prepareSetupUndo = Effect.fn("SetupUndo.prepare")(function* (
  home: string,
  operationId: string,
) {
  const library = yield* Service;
  const plan = yield* library.plan({ _tag: "Undo", operationId }, { base: yield* library.read });
  const settings = yield* MachineSettings.planRestoreDiscovery(home, operationId);
  const { next: _next, ...change } = plan.change;
  const conflicts = [...change.conflicts, ...settings.conflicts];
  const settingsChanged = settings.changed;
  const planId = hashParts([plan.planId, settings.planId]);
  const summary = {
    ...change,
    planId,
    conflicts,
    status: conflicts.length
      ? ("conflicted" as const)
      : change.status === "already-undone" && !settingsChanged
        ? ("already-undone" as const)
        : ("ready" as const),
    settingsChanged,
  };
  return {
    summary,
    apply: () =>
      Effect.gen(function* () {
        if (conflicts.length)
          return yield* new RecoveryInvalid({ reason: { _tag: "Conflicts", conflicts } });
        // Refuse an already-stale machine review before Library starts its file/state work.
        const current = yield* MachineSettings.planRestoreDiscovery(home, operationId);
        if (canonicalJson(current) !== canonicalJson(settings))
          return yield* new StalePlan({
            reason: { _tag: "ReviewedStateChanged" },
          });
        const owner = yield* Service;
        const undone = yield* owner.apply({ _tag: "Apply", plan: plan }).pipe(
          Effect.map((outcome) => outcome.result),
          Effect.catchTag("Library.StalePlan", () =>
            Effect.fail(new StalePlan({ reason: { _tag: "ReviewedStateChanged" } })),
          ),
        );
        yield* MachineSettings.applyRestoreDiscovery(home, settings);
        if (undone._tag === "Undone")
          return { ...summary, status: "undone" as const, backupId: undone.backupId };
        return {
          ...summary,
          status: settingsChanged ? ("undone" as const) : ("already-undone" as const),
        };
      }),
  };
});
