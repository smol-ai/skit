import { originalTreePath } from "./original-tree.js";
import { assert } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";

import * as Library from "@smolai/skit-core/library";
import { importSource, previewLibrarySource } from "../../src/library/source.js";
import { writingTo } from "./library-home.js";
import { testRoots } from "./roots.js";

export const gitBlobHash = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

export const assertCollectionImport = Effect.fn("Test.assertCollectionImport")(function* (
  source: string,
  expectedPaths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-real-collection-" });
  const preview = yield* previewLibrarySource(source);
  assert.deepStrictEqual(
    preview.skills.map((skill) => skill.verbatim_path).toSorted(),
    [...expectedPaths].toSorted(),
  );
  const added = yield* writingTo(home, importSource(source));
  assert.deepStrictEqual(added.skills, preview.skills);
  const snapshot = yield* Effect.flatMap(Library.Service, (library) => library.read).pipe(
    Effect.provide(Library.layer({ home, roots: testRoots(home) })),
  );
  assert.strictEqual(snapshot._tag, "Present");
  const state = snapshot._tag === "Present" ? snapshot.state : assert.fail("no Library state");
  assert.strictEqual(state.collections.length, 1);
  assert.strictEqual(state.skills.length, expectedPaths.length);
  assert.strictEqual(new Set(state.skills.map((skill) => skill.name)).size, state.skills.length);
  const imported = originalTreePath(join(home, "originals"), added.snapshot_digest);
  assert.strictEqual(yield* fs.exists(join(imported, "plugins")), false);
  return { preview, imported };
});
