import { join } from "node:path";

/** Whole-tree storage layout for independently inspecting or corrupting native test fixtures. */
export function originalTreePath(originals: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(originals, hex.slice(0, 2), hex);
}
