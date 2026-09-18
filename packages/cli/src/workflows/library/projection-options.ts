import type { InventoryRootOptions } from "../../projection/roots.js";

/** Device-local roots used when reconciling retained Collection projections. */
export interface ProjectionOptions extends InventoryRootOptions {
  readonly statePath: string;
  readonly variantsPath: string;
}
