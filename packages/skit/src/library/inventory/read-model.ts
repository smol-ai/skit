import { libraryInventory, type LibraryState } from "../library-state.js";
import { pathIsWithin } from "../../platform/path-identity.js";
import type { InventoryScanRoot } from "./roots.js";

/** Narrow reported observations only; the owner saves the complete scanned state. */
export const inventoryForRoots = (state: LibraryState, roots: readonly InventoryScanRoot[]) => ({
  ...libraryInventory(state),
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
});
