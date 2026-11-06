import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { removeCollection } from "../src/library/remove.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { skitConfigurationLayer } from "../src/platform/configuration.js";
import { testRoots } from "./helpers/library-store.js";

it.effect(
  "a dry run reports the removal without writing; removal takes the sole Skill's Collection",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-remove-session-" });
      const home = join(root, "library");
      const source = join(root, "source");
      yield* fs.makeDirectory(source);
      const path = join(source, "SKILL.md");
      const bytes = "---\nname: review\ndescription: Removal fixture\n---\noriginal bytes\n";
      yield* fs.writeFileString(path, bytes);
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
        if (Option.isNone(request)) return yield* Effect.die("Expected Skill source");
        yield* library.import.collection(request.value);
        const before = yield* fs.readFileString(join(home, "state.json"));
        const planned = yield* removeCollection({ query: "review", dryRun: true });
        assert.strictEqual(planned.kind, "plan");
        assert.strictEqual(planned.value.skills, 1);
        assert.strictEqual(planned.value.versions, 1);
        assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
        assert.strictEqual(yield* fs.readFileString(path), bytes);
        const removed = yield* removeCollection({ query: "review", dryRun: false });
        assert.strictEqual(removed.kind, "removed");
        assert.strictEqual(removed.value.skills, 1);
        assert.strictEqual(removed.value.versions, 1);
        const after = yield* library.read;
        assert.strictEqual(after._tag, "Present");
        if (after._tag === "Present") {
          assert.deepStrictEqual(after.state.collections, []);
          assert.deepStrictEqual(after.state.skills, []);
        }
        // The source folder is the user's; removal touches only the Library.
        assert.strictEqual(yield* fs.readFileString(path), bytes);
      }).pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
        Effect.provide(skitConfigurationLayer(home)),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
