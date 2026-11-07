import { originalTreePath } from "./helpers/original-tree.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Library from "@smolai/skit-core/library";
import { importSource, previewLibrarySource } from "../src/library/source.js";
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
      assert.deepStrictEqual((yield* previewLibrarySource(source)).skills, expected);
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-humanlayer-import-" });
      const result = yield* writingTo(home, importSource(source));
      assert.deepStrictEqual(result.skills, expected);
      const snapshot = yield* writingTo(
        home,
        Effect.flatMap(Library.Service, (library) => library.read),
      );
      assert.strictEqual(snapshot._tag, "Present");
      if (snapshot._tag !== "Present") return;
      const state = snapshot.state;
      assert.strictEqual(state.collections.length, 1);
      assert.deepStrictEqual(
        state.skills.map((skill) => skill.path),
        manifest.skills.map((skill) => skill.path),
      );
      const imported = originalTreePath(join(home, "originals"), result.snapshot_digest);
      for (const file of manifest.files) {
        if (!manifest.skills.some((skill) => file.path.startsWith(`${skill.path}/`))) continue;
        assert.strictEqual(
          gitBlobHash(yield* fs.readFile(join(imported, file.path))),
          file.gitBlob,
          file.path,
        );
      }
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
