import type { InstallDestination } from "@smolai/skit-core/library";
import type { HarnessName } from "@smolai/skit-core/harnesses";
import {
  installDestinationsFor,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "@smolai/skit-core/library/routing";

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
