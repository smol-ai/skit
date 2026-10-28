import type { HarnessName, InstallDestination } from "@smolai/skit-core";
import {
  installDestinationsFor,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "../install/roots.js";

export interface LibraryInstallationConfiguration {
  /** A target's global root, or undefined when the target is inactive on this device. */
  readonly rootFor: (target: InstallDestination) => string | undefined;
}

/** Installation configuration only; never acquires or caches authoritative Library state. */
export function libraryInstallationConfiguration(
  roots: InventoryRootOptions,
  detected: readonly HarnessName[],
): LibraryInstallationConfiguration {
  const active = installDestinationsFor(detected);
  return {
    rootFor: (target) =>
      active.includes(target) ? skillsDirectoryFor(target, { kind: "global" }, roots) : undefined,
  };
}
