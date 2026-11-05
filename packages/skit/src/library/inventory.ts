/** Inventory refresh and read reports belong to Library; frontends provide roots and rendering. */
import { Effect } from "effect";
import * as Library from "./library.js";
import { emptyLibraryState } from "./library-state.js";
import { selectInventoryRoots, type InventoryRootOptions } from "./routing/roots.js";

export { LibraryInventory } from "./library-state.js";
export { libraryDoctorReport, LibraryDoctorReport } from "./inventory/doctor-report.js";

/** Read, select roots, scan and apply through the owner; return no persisted-state representation. */
export const refreshInventory = Effect.fn("Library.refreshInventory")(function* (
  options: InventoryRootOptions,
) {
  const library = yield* Library.Service;
  const base = yield* library.read;
  const roots = selectInventoryRoots(
    base._tag === "Present" ? base.state : emptyLibraryState(),
    options,
  );
  const plan = yield* library.plan({ _tag: "RefreshInventory", roots }, { base });
  const outcome = yield* library.apply({ _tag: "Apply", plan });
  return outcome.result.inventory;
});
