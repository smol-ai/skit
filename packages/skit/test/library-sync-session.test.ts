import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Result } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { openSyncSession } from "../src/library/session.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("sync session captures review inputs and refuses redirected staged content", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-session-" });
    const source = join(home, "source");
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: review\n---\nReview\n",
    );
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const imported = yield* localImportRequest(source, "2026-11-06T00:00:00Z");
      if (Option.isNone(imported)) return yield* Effect.die("Missing source");
      yield* library.import.collection(imported.value);
      const base = yield* library.read;
      if (base._tag !== "Present") return yield* Effect.die("Missing Library");
      const manifest = yield* libraryManifestFromLocalState(base.state);
      const label = manifest.collections[0]!.label;
      const remote = {
        library_id: "reviewed-library",
        revision_id: "reviewed-revision",
        manifest: structuredClone(manifest),
      };
      const opening = openSyncSession({ origin: "https://registry.test", remote }, { base });
      // Mutating caller-owned data after constructing the Effect cannot change its review.
      Reflect.set(remote.manifest.collections[0]!, "label", "changed remote input");
      Reflect.set(base.state.collections[0]!, "label", "changed local input");
      const session = yield* opening;
      assert.strictEqual(session._tag, "Ready");
      if (session._tag !== "Ready") return;
      assert.strictEqual(session.target.collections[0]?.label, label);
      const reviewed = structuredClone(session.target);
      Reflect.set(session.target.collections[0]!, "label", "redirected view");
      const sourceContent = {
        localArchives: yield* library.content.pack(yield* library.read),
        registry: { origin: "https://registry.test", token: Option.none<string>() },
      };
      const foreign = yield* library.content.stage(session.target, sourceContent);
      const before = yield* fs.readFileString(join(home, "state.json"));
      const rejected = yield* Effect.result(session.prepare(foreign));
      assert.isTrue(Result.isFailure(rejected));
      if (Result.isFailure(rejected))
        assert.strictEqual(rejected.failure._tag, "Library.StalePlan");
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
      const staged = yield* library.content.stage(reviewed, sourceContent);
      const preparing = session.prepare(staged);
      Reflect.set(staged.state.collections[0]!, "label", "changed staged input");
      const prepared = yield* preparing;
      yield* prepared.checkCurrent;
      yield* prepared.apply({ library_id: "reviewed-library", revision_id: "reviewed-revision" });
      const after = yield* library.read;
      assert.strictEqual(after._tag, "Present");
      if (after._tag === "Present") {
        assert.strictEqual(after.state.collections[0]?.label, label);
        assert.strictEqual(after.state.sync_ancestry?.base_manifest.collections[0]?.label, label);
      }
    }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
