import { refreshInventory } from "@smolai/skit-core/library/inventory";
import { skillModificationTime } from "@smolai/skit-core/library/session";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { runSetup } from "@smolai/skit-core/library/setup";
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
  const library = yield* refreshLibraryInventoryCommand(options);
  const renderer = yield* Renderer;
  const scan = yield* renderer.withStatus(
    "Scanning repository and harness skills",
    runSetup({
      libraryHome: options.libraryHome,
      inventory: options,
      persistRoots: false,
      scanDecidedRepositories: true,
    }),
  );
  return {
    ...library,
    machine: {
      repositoryRoots: scan.machineConfig.repositoryRoots,
      repositoryDecisions: scan.machineConfig.repositoryDecisions,
      scan: scan.scan,
      instances: yield* Effect.forEach(
        scan.instances,
        (instance) =>
          skillModificationTime(instance.path).pipe(
            Effect.map((modified) => ({
              ...instance,
              skill_md_modified_at: modified,
            })),
          ),
        { concurrency: 8 },
      ),
      brokenLinks: scan.brokenLinks,
      suppressed: scan.suppressed,
    },
  };
});
