import type { HarnessName, InstallDestination } from "@smolai/skit-core";
import {
  activeInstallDestinations,
  bindingRoot,
  type InventoryRootOptions,
} from "../projection/roots.js";

export interface LibraryInstallationConfiguration {
  /** A target's global root, or undefined when the target is inactive on this device. */
  readonly rootFor: (target: InstallDestination) => string | undefined;
}

/** Installation configuration only; never acquires or caches authoritative Library state. */
export function libraryInstallationConfiguration(
  roots: InventoryRootOptions,
  detected: readonly HarnessName[],
): LibraryInstallationConfiguration {
  const active = activeInstallDestinations(detected);
  return {
    rootFor: (target) =>
      active.includes(target) ? bindingRoot(target, { kind: "global" }, roots) : undefined,
  };
}
