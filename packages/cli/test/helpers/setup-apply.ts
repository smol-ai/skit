import { Effect } from "effect";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { applySetupPlan } from "@smolai/skit-core/library/setup";
import type { SetupOptions } from "@smolai/skit-core/library/setup";
import type { SetupKnownSourceSelection, SetupResult } from "@smolai/skit-core/library/setup";
import type { SetupCopySelection } from "@smolai/skit-core/library/setup";

/**
 * Apply these selections from `scan` through setup's one apply path, updating no existing copies.
 * `beforeSteps` runs once the steps are built and before the Library runs any of them.
 */
export const applySetupSelections = (
  setup: SetupOptions,
  scan: SetupResult,
  installOptions: InventoryRootOptions,
  selections: {
    readonly imports?: readonly SetupKnownSourceSelection[];
    readonly bindings?: readonly SetupCopySelection[];
    readonly ownership?: readonly SetupCopySelection[];
  },
  beforeSteps?: Effect.Effect<void, unknown>,
) =>
  applySetupPlan(
    {
      manage: { installOptions },
      withStatus: (message, stage) =>
        beforeSteps !== undefined && message.startsWith("Applying setup")
          ? Effect.andThen(Effect.orDie(beforeSteps), stage)
          : stage,
    },
    {
      setup,
      planId: scan.onboarding.planId,
      persistRoots: false,
      imports: selections.imports ?? [],
      bindings: selections.bindings ?? [],
      ownership: selections.ownership ?? [],
      removals: { entries: [], folders: [] },
      changes: [],
    },
  );
