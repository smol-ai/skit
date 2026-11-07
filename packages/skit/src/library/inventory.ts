import { scanForSetup } from "./setup/scan.js";
import type { Interface } from "./library.js";
import { skillModificationTime } from "./internal/session/skill-metadata.js";
/** Inventory refresh and read reports belong to Library; frontends provide roots and rendering. */
import { Effect } from "effect";
import { Service } from "./service.js";
import { emptyLibraryState, libraryInventory } from "./library-state.js";
import { selectInventoryRoots, type InventoryRootOptions } from "./routing/roots.js";

export { LibraryInventory } from "./library-state.js";
export { libraryDoctorReport } from "./inventory/doctor-report.js";

/** Read the saved inventory without scanning, preparing a mutation or exposing absent-state layout. */
export const readInventory = Effect.gen(function* () {
  const library = yield* Service;
  const snapshot = yield* library.read;
  return libraryInventory(snapshot._tag === "Present" ? snapshot.state : emptyLibraryState());
});

/** Read, select roots, scan and apply through the owner; return no persisted-state representation. */
export const refreshInventory = Effect.fn("Library.refreshInventory")(function* (
  library: Pick<Interface, "read" | "plan" | "apply">,
  options: InventoryRootOptions,
) {
  const base = yield* library.read;
  const roots = selectInventoryRoots(
    base._tag === "Present" ? base.state : emptyLibraryState(),
    options,
  );
  const plan = yield* library.plan({ _tag: "RefreshInventory", roots }, { base });
  const outcome = yield* library.apply({ _tag: "Apply", plan });
  return outcome.result.inventory;
});

export { inspectOwnershipMarker } from "../installed-skills/marker-inspection.js";

/** One owner assembles the saved inventory and this machine's discovered copy facts. */
export const refreshMachineInventory = Effect.fn("Library.refreshMachineInventory")(function* (
  owner: Pick<Interface, "read" | "plan" | "apply">,
  options: InventoryRootOptions & { readonly libraryHome: string },
) {
  const library = yield* refreshInventory(owner, options);
  const { scan } = yield* scanForSetup(owner, {
    libraryHome: options.libraryHome,
    inventory: options,
    persistRoots: false,
    scanDecidedRepositories: true,
  });
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
            Effect.map((modified) => ({ ...instance, skill_md_modified_at: modified })),
          ),
        { concurrency: 8 },
      ),
      brokenLinks: scan.brokenLinks,
      suppressed: scan.suppressed,
    },
  };
});

export { DoctorReport, inspectNativeDiscovery } from "./internal/doctor/harnesses.js";
