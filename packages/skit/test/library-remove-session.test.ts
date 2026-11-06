import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { openRemoveSession } from "../src/library/remove.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("removal captures a passive preview and refuses a changed Library before applying", () =>
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
      const selection = yield* openRemoveSession(home, "review");
      assert.strictEqual(selection.summary.skills, 1);
      assert.strictEqual(selection.summary.versions, 1);
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
      assert.strictEqual(yield* fs.readFileString(path), bytes);
      yield* fs.writeFileString(path, `${bytes}changed upstream\n`);
      const changed = yield* localImportRequest(source, "2026-11-04T00:00:01.000Z");
      if (Option.isNone(changed)) return yield* Effect.die("Expected changed Skill source");
      yield* library.import.collection(changed.value);
      const current = yield* fs.readFileString(join(home, "state.json"));
      const refused = yield* Effect.result(selection.apply());
      assert.strictEqual(refused._tag, "Failure");
      if (refused._tag === "Failure") assert.strictEqual(refused.failure._tag, "Library.StalePlan");
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), current);
      const fresh = yield* openRemoveSession(home, "review");
      fresh.summary.skills = 999;
      const removed = yield* fresh.apply();
      assert.strictEqual(removed.skills, 1);
      assert.strictEqual(removed.versions, 2);
      const after = yield* library.read;
      assert.strictEqual(after._tag, "Present");
      if (after._tag === "Present") {
        assert.deepStrictEqual(after.state.collections, []);
        assert.deepStrictEqual(after.state.skills, []);
      }
      assert.strictEqual(yield* fs.readFileString(path), `${bytes}changed upstream\n`);
    }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
