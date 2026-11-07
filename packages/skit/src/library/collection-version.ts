import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { walkTree } from "../artifact/tree.js";
import type { Hash } from "../shared/hash.js";

export const collectionVersionPath = (objectsPath: string, hash: Hash) =>
  join(objectsPath, hash.slice(7, 9), hash.slice(7));

export const originalTreeHash = Effect.fn("CollectionVersion.originalHash")(function* (
  root: string,
) {
  const hash = createHash("sha256");
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
    hash.update("\0");
  };
  for (const entry of yield* walkTree(root, "verbatim")) {
    append(entry.path);
    append(entry.kind);
    if (entry.kind === "file") {
      append(String(entry.mode));
      append(entry.bytes);
    } else if (entry.kind === "symlink") append(entry.target);
  }
  return `sha256:${hash.digest("hex")}` as Hash;
});
