import { assert } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LibraryStore, libraryStoreLayer, retainedTreePath } from "@smolai/skit-core";
import {
  addLibrarySourceEffect,
  previewLibrarySourceEffect,
} from "../../src/workflows/library/add.js";
import { writingTo } from "./library-home.js";

export const gitBlobHash = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

export const assertCollectionImport = Effect.fn("Test.assertCollectionImport")(function* (
  source: string,
  expectedPaths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-real-collection-" });
  const preview = yield* previewLibrarySourceEffect(source);
  assert.deepStrictEqual(
    preview.skills.map((skill) => skill.verbatim_path).toSorted(),
    [...expectedPaths].toSorted(),
  );
  const added = yield* writingTo(home, addLibrarySourceEffect(source));
  assert.deepStrictEqual(added.skills, preview.skills);
  const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
    Effect.provide(libraryStoreLayer({ home })),
  );
  assert.strictEqual(state.collections.length, 1);
  assert.strictEqual(state.skills.length, expectedPaths.length);
  assert.strictEqual(new Set(state.skills.map((skill) => skill.name)).size, state.skills.length);
  const retained = retainedTreePath(join(home, "originals"), added.snapshot_digest);
  assert.strictEqual(yield* fs.exists(join(retained, "plugins")), false);
  return { preview, retained };
});
