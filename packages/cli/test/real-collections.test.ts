import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "@smolai/skit-core";
import { previewLibrarySourceEffect } from "../src/workflows/library/add.js";
import { assertCollectionImport, gitBlobHash } from "./helpers/collection-import.js";
import manifest from "./fixtures/collections/manifest.json" with { type: "json" };

const fixtures = fileURLToPath(new URL("./fixtures/collections/", import.meta.url));

for (const collection of manifest) {
  it.effect(`imports verbatim upstream excerpts from ${collection.repository}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = join(fixtures, collection.id);
      // Git blob hashes pin upstream bytes and symlink targets, independently of discovery.
      for (const file of collection.files) {
        const path = join(source, file.path);
        const bytes =
          file.mode === "120000"
            ? new TextEncoder().encode(yield* fs.readLink(path))
            : yield* fs.readFile(path);
        assert.strictEqual(gitBlobHash(bytes), file.gitBlob, file.path);
      }
      const { preview, retained } = yield* assertCollectionImport(
        source,
        collection.skills.map((skill) => skill.path),
      );
      assert.deepStrictEqual(
        preview.skills
          .map((skill) => ({ name: skill.name, path: skill.verbatim_path }))
          .toSorted((a, b) => a.path.localeCompare(b.path)),
        collection.skills.toSorted((a, b) => a.path.localeCompare(b.path)),
      );
      for (const file of collection.files) {
        if (!collection.skills.some((skill) => file.path.startsWith(`${skill.path}/`))) continue;
        assert.strictEqual(
          gitBlobHash(yield* fs.readFile(join(retained, file.path))),
          file.gitBlob,
          file.path,
        );
      }
      for (const path of collection.excluded) {
        assert.strictEqual(yield* fs.exists(join(source, path, "SKILL.md")), true);
        assert.strictEqual(yield* fs.exists(join(retained, path)), false);
      }
      for (const selected of collection.explicit) {
        const explicit = yield* previewLibrarySourceEffect(join(source, selected.path));
        assert.deepStrictEqual(explicit.skills, [{ name: selected.name, verbatim_path: "." }]);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}
