import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "@smolai/skit-core";
import { previewLibrarySourceEffect } from "../src/workflows/library/add.js";
import { assertCollectionImport } from "./helpers/collection-import.js";
import manifest from "./fixtures/collections/full-manifest.json" with { type: "json" };

const cache = fileURLToPath(
  new URL("../../../node_modules/.cache/skit-collections/", import.meta.url),
);
for (const collection of manifest) {
  it.effect(`imports the complete pinned ${collection.repository} snapshot`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const archive = join(cache, `${collection.commit}.tar.gz`);
      assert.strictEqual(
        createHash("sha256")
          .update(yield* fs.readFile(archive))
          .digest("hex"),
        collection.sha256,
      );
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "skit-full-collection-" });
      yield* Effect.sync(() =>
        execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source]),
      );
      yield* assertCollectionImport(source, collection.skillPaths);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect.skipIf(process.env.SKIT_COLLECTIONS_GITHUB !== "1")(
  "discovers the pinned NVIDIA collection through GitHub Git transport",
  () =>
    Effect.gen(function* () {
      const collection = manifest.find((entry) => entry.repository === "NVIDIA/skills");
      if (collection === undefined) return assert.fail("Missing NVIDIA upstream pin");
      const preview = yield* previewLibrarySourceEffect({
        type: "github",
        owner: "NVIDIA",
        repository: "skills",
        ref: collection.commit,
      });
      assert.deepStrictEqual(
        preview.skills.map((skill) => skill.verbatim_path).toSorted(),
        collection.skillPaths,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.skipIf(process.env.SKIT_COLLECTIONS_GITHUB !== "1")(
  "imports the pinned A Smart Bear GitHub plugin symlink through subpath and member selection",
  () =>
    Effect.gen(function* () {
      const collection = manifest.find((entry) => entry.repository === "asmartbear/asb-skills");
      if (collection === undefined) return assert.fail("Missing A Smart Bear upstream pin");
      const path = "plugins/asb-skills/skills/asb-positioning";
      for (const selection of [{ subpath: path }, { skillDirectories: [path] }]) {
        const preview = yield* previewLibrarySourceEffect({
          type: "github",
          owner: "asmartbear",
          repository: "asb-skills",
          ref: collection.commit,
          ...selection,
        });
        assert.deepStrictEqual(preview.skills, [
          {
            name: "asb-positioning",
            verbatim_path: "subpath" in selection ? "." : path,
          },
        ]);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
