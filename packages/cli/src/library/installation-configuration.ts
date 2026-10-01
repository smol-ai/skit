import { join } from "node:path";
import type { HarnessName, ProjectionTarget } from "@smolai/skit-core";
import {
  activeProjectionTargets,
  bindingRoot,
  type InventoryRootOptions,
} from "../projection/roots.js";

export interface LibraryInstallationConfiguration {
  readonly statePath: string;
  readonly variantsPath: string;
  /** A target's global root, or undefined when the target is inactive on this device. */
  readonly rootFor: (target: ProjectionTarget) => string | undefined;
}

/** Installation configuration only; never acquires or caches authoritative Library state. */
export function libraryInstallationConfiguration(
  home: string,
  roots: InventoryRootOptions,
  detected: readonly HarnessName[],
): LibraryInstallationConfiguration {
  const active = activeProjectionTargets(detected);
  return {
    statePath: join(home, "state.json"),
    variantsPath: join(home, "variants"),
    rootFor: (target) =>
      active.includes(target) ? bindingRoot(target, { kind: "global" }, roots) : undefined,
  };
}
