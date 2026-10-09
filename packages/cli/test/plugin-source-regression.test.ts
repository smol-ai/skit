import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryStore, libraryStoreLayer, retainedTreePath, skitLayer } from "@smolai/skit-core";
import {
  addLibrarySourceEffect,
  previewLibrarySourceEffect,
} from "../src/workflows/library/add.js";
import { gitBlobHash } from "./helpers/collection-import.js";
import { writingTo } from "./helpers/library-home.js";
import manifest from "./fixtures/source-regressions/humanlayer.json" with { type: "json" };

it.effect(
  "imports the complete pinned HumanLayer plugin-only Source without changing member paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = fileURLToPath(
        new URL("./fixtures/source-regressions/humanlayer/", import.meta.url),
      );
      for (const file of manifest.files)
        assert.strictEqual(
          gitBlobHash(yield* fs.readFile(join(source, file.path))),
          file.gitBlob,
          file.path,
        );
      const expected = manifest.skills.map((skill) => ({
        name: skill.name,
        verbatim_path: skill.path,
      }));
      assert.deepStrictEqual((yield* previewLibrarySourceEffect(source)).skills, expected);
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-humanlayer-import-" });
      const result = yield* writingTo(home, addLibrarySourceEffect(source));
      assert.deepStrictEqual(result.skills, expected);
      const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(libraryStoreLayer({ home })),
      );
      assert.strictEqual(state.collections.length, 1);
      assert.deepStrictEqual(
        state.skills.map((skill) => skill.path),
        manifest.skills.map((skill) => skill.path),
      );
      const retained = retainedTreePath(join(home, "originals"), result.snapshot_digest);
      for (const file of manifest.files) {
        if (!manifest.skills.some((skill) => file.path.startsWith(`${skill.path}/`))) continue;
        assert.strictEqual(
          gitBlobHash(yield* fs.readFile(join(retained, file.path))),
          file.gitBlob,
          file.path,
        );
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
