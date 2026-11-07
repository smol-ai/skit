import { resolve } from "node:path";
import type { HarnessName } from "../../harnesses/contracts.js";

export interface InventoryScanRoot {
  readonly harness: HarnessName;
  readonly root: string;
}
export function deduplicateInventoryRoots(
  roots: readonly InventoryScanRoot[],
): InventoryScanRoot[] {
  return [
    ...new Map(
      roots.map(({ harness, root }) => [
        JSON.stringify([harness, resolve(root)]),
        { harness, root: resolve(root) },
      ]),
    ).values(),
  ];
}
