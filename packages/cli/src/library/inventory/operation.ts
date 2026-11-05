import { Library } from "@smolai/skit-core/library";
import {
  emptyLibraryState,
  libraryInventory,
  type LibraryState,
  type InventoryScanRoot,
} from "@smolai/skit-core";
import { pathIsWithin } from "@smolai/skit-core/platform";
import { skillModificationTime } from "@smolai/skit-core/library/session";
import { selectInventoryRoots, type InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { runSetup } from "@smolai/skit-core/library/setup";
import { Effect } from "effect";
import { Renderer } from "../../terminal/renderer.js";

export type CliInventoryOptions = InventoryRootOptions & { readonly libraryHome: string };

/** The selected roots narrow presentation only; Library saves the complete observation. */
const inventoryForRoots = (
  state: LibraryState,
  roots: readonly InventoryScanRoot[],
): LibraryState => {
  return {
    ...state,
    unmanaged: state.unmanaged.filter((item) =>
      roots.some(({ root }) => pathIsWithin(root, item.path)),
    ),
    ownershipIssues: (state.ownershipIssues ?? []).filter((item) =>
      roots.some(({ root }) => pathIsWithin(root, item.path)),
    ),
    ...(state.scanIssues
      ? {
          scanIssues: state.scanIssues.filter((item) =>
            roots.some(({ root }) => pathIsWithin(root, item.path)),
          ),
        }
      : {}),
  };
};

/**
 * The reference CLI workflow: application services enter through the environment, the complete
 * operation stays on the root fiber, and its exact domain failures reach the application boundary.
 */
export const refreshLibraryInventoryCommand = Effect.fn("CLI.refreshLibraryInventory")(function* (
  options: CliInventoryOptions,
) {
  const renderer = yield* Renderer;
  const library = yield* Library.Service;
  const before = yield* library.read;
  const roots = selectInventoryRoots(
    before._tag === "Present" ? before.state : emptyLibraryState(),
    options,
  );
  const outcome = yield* renderer.withStatus(
    "Scanning harness installations",
    Effect.gen(function* () {
      const plan = yield* library.plan({ _tag: "RefreshInventory", roots }, { base: before });
      return yield* library.apply({ _tag: "Apply", plan: plan });
    }),
  );
  return inventoryForRoots(outcome.result.state, outcome.result.roots);
});

export const inventoryCommand = Effect.fn("CLI.inventory")(function* (
  options: CliInventoryOptions,
) {
  const library = libraryInventory(yield* refreshLibraryInventoryCommand(options));
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
