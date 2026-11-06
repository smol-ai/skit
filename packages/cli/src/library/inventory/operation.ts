import { refreshInventory, refreshMachineInventory } from "@smolai/skit-core/library/inventory";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { Effect } from "effect";
import { Renderer } from "../../terminal/renderer.js";

export type CliInventoryOptions = InventoryRootOptions & { readonly libraryHome: string };

/** Library owns the complete refresh; CLI only renders progress and consumes its report. */
export const refreshLibraryInventoryCommand = Effect.fn("CLI.refreshLibraryInventory")(function* (
  options: CliInventoryOptions,
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus("Scanning harness installations", refreshInventory(options));
});

export const inventoryCommand = Effect.fn("CLI.inventory")(function* (
  options: CliInventoryOptions,
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Scanning repository and harness skills",
    refreshMachineInventory(options),
  );
});
