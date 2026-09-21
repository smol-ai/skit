import { join } from "node:path";
import type { HarnessName } from "@smolai/skit-core";
import { bindingRoot, type InventoryRootOptions } from "../projection/roots.js";

export interface LibraryInstallationConfiguration {
  readonly statePath: string;
  readonly variantsPath: string;
  readonly rootFor: (harness: HarnessName) => string | undefined;
}

/** Installation configuration only; never acquires or caches authoritative Library state. */
export function libraryInstallationConfiguration(
  home: string,
  roots: InventoryRootOptions,
  detected: readonly HarnessName[],
): LibraryInstallationConfiguration {
  return {
    statePath: join(home, "state.json"),
    variantsPath: join(home, "variants"),
    rootFor: (harness) =>
      detected.includes(harness) ? bindingRoot(harness, { kind: "global" }, roots) : undefined,
  };
}
