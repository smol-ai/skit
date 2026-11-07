import { join } from "node:path";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

/** A device whose roots sit under the Library home, so detection finds no harness there. */
export const testRoots = (home: string): InventoryRootOptions => ({
  home: join(home, "device-home"),
  configHome: join(home, "device-home", ".config"),
  overrides: {},
});
