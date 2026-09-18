import { copyLocalTreeEffect } from "../../platform/copy-tree.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { walkTreeEffect } from "../../artifact/tree.js";
import { ContentAddressCollision } from "../../failures.js";
import { deterministicTreeHashEffect } from "../../artifact/skit.js";
import type { Digest } from "../../contracts.js";

export const retainedTreePath = (objectsPath: string, digest: Digest) =>
  join(objectsPath, digest.slice(7, 9), digest.slice(7));

/** Materialize exactly the normalized inventory; excluded source residue never enters an object. */
const copyNormalizedTreeEffect = Effect.fn("Retention.copyNormalizedTree")(function* (
  root: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(destination, { recursive: true, mode: 0o700 });
  for (const entry of yield* walkTreeEffect(root, "normalized")) {
    if (entry.kind !== "file") continue;
    const path = join(destination, entry.path);
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    yield* fs.writeFile(path, entry.bytes, { flag: "wx", mode: entry.mode });
  }
});

export const originalTreeHashEffect = Effect.fn("Retention.originalHash")(function* (root: string) {
  const hash = createHash("sha256");
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
    hash.update("\0");
  };
  for (const entry of yield* walkTreeEffect(root, "verbatim")) {
    append(entry.path);
    append(entry.kind);
    if (entry.kind === "file") {
      append(String(entry.mode));
      append(entry.bytes);
    } else if (entry.kind === "symlink") append(entry.target);
  }
  return `sha256:${hash.digest("hex")}` as Digest;
});

/** Published immutable objects are never rollback-owned, even when this call created them. */
export const retainLocalTreeEffect = Effect.fn("Retention.retainTree")(function* (
  root: string,
  objectsPath: string,
  expected: Digest,
  verbatim: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = retainedTreePath(objectsPath, expected);
  const hash = verbatim ? originalTreeHashEffect : deterministicTreeHashEffect;
  if (yield* fs.exists(path)) {
    if ((yield* hash(path)) !== expected) return yield* new ContentAddressCollision();
    return path;
  }
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: dirname(path), prefix: "retain.tmp-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const temporary = join(directory, "tree");
      if (verbatim)
        yield* copyLocalTreeEffect(
          root,
          temporary,
          [join(root, ".skit"), join(root, ".git")],
          true,
        );
      else yield* copyNormalizedTreeEffect(root, temporary);
      if ((yield* hash(temporary)) !== expected) return yield* new ContentAddressCollision();
      // Another writer's immutable object is never replaced or removed on rollback.
      if (yield* fs.exists(path)) {
        if ((yield* hash(path)) !== expected) return yield* new ContentAddressCollision();
      } else yield* fs.rename(temporary, path).pipe(Effect.uninterruptible);
    }),
  );
  return path;
});
