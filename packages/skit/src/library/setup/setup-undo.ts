import { Effect } from "effect";
import { canonicalJson } from "../../shared/json.js";
import { hashParts } from "../../artifact/descriptor.js";
import * as MachineSettings from "../machine-settings.js";
import { PlanIsStale, RecoveryInvalid } from "../internal/recovery/evidence.js";
import { Library } from "../library.js";

/** A combined review of two independently durable owner operations. No store or writer is opened. */
export const prepareSetupUndo = Effect.fn("SetupUndo.prepare")(function* (
  home: string,
  operationId: string,
) {
  const library = yield* Library.Service;
  const plan = yield* library.plan({ _tag: "Undo", operationId }, { base: yield* library.read });
  const settings = plan.settingsCompleted
    ? undefined
    : yield* MachineSettings.planRestoreDiscovery(home, operationId, plan.legacyDiscovery);
  const { next: _next, ...change } = plan.change;
  const conflicts = [...change.conflicts, ...(settings?.conflicts ?? [])];
  const settingsChanged = settings?.changed ?? false;
  const planId = hashParts([plan.planId, settings?.planId ?? "completed"]);
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
        if (conflicts.length) return yield* new RecoveryInvalid({ detail: conflicts.join("; ") });
        // Refuse an already-stale machine review before Library starts its file/state work.
        if (settings !== undefined) {
          const current = yield* MachineSettings.planRestoreDiscovery(
            home,
            operationId,
            plan.legacyDiscovery,
          );
          if (canonicalJson(current) !== canonicalJson(settings)) return yield* new PlanIsStale();
        }
        const owner = yield* Library.Service;
        const undone = yield* owner.apply(plan).pipe(
          Effect.map((outcome) => outcome.result),
          Effect.catchTag("Library.StalePlan", () => Effect.fail(new PlanIsStale())),
        );
        if (settings !== undefined) yield* MachineSettings.applyRestoreDiscovery(home, settings);
        if (undone._tag === "Undone")
          return { ...summary, status: "undone" as const, backupId: undone.backupId };
        return {
          ...summary,
          status: settingsChanged ? ("undone" as const) : ("already-undone" as const),
        };
      }),
  };
});
