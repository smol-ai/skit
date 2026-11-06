import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { runSetup, openSetupReview, prepareSetupUndo } from "../src/library/setup.js";
import * as Library from "../src/library/library.js";
import { inLibrary, libraryLayer } from "./helpers/library-store.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("core setup reviews, applies and undoes a local copy without frontend services", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-core-setup-" }),
    );
    const home = join(root, "library");
    const skillsRoot = join(root, ".claude", "skills");
    const folder = join(skillsRoot, "review");
    const bytes = "---\nname: review\ndescription: Core setup fixture\n---\nOriginal bytes.\n";
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(join(folder, "SKILL.md"), bytes);
    const inventory = {
      home: root,
      configHome: join(root, "config"),
      overrides: { "claude-code": [skillsRoot] },
    };
    const options = {
      libraryHome: home,
      inventory,
      persistRoots: false,
      probePath: "",
      skillsStateHome: join(root, "state"),
    };
    yield* Effect.gen(function* () {
      assert.isFalse(yield* fs.exists(join(home, "machine.json")));
      const review = yield* openSetupReview(options, { installOptions: inventory });
      const plan = yield* review.prepareRecommended(undefined);
      assert.isTrue(plan.hasChanges);
      assert.isFalse(yield* fs.exists(join(home, "machine.json")));
      const applied = yield* plan.apply((_message, effect) => effect);
      const library = yield* Library.Service;
      const after = yield* library.read;
      assert.strictEqual(after._tag, "Present");
      if (after._tag !== "Present") return;
      assert.strictEqual(after.state.skills.length, 1);
      assert.strictEqual(after.state.enabled.length, 1);
      const undo = yield* prepareSetupUndo(home, applied.operationId);
      assert.strictEqual(undo.summary.status, "ready");
      assert.strictEqual((yield* undo.apply()).status, "undone");
      const undone = yield* library.read;
      assert.strictEqual(undone._tag, "Present");
      if (undone._tag === "Present") {
        assert.strictEqual(undone.state.enabled.length, 0);
        // Undo reverses setup intent; retained content remains available.
        assert.strictEqual(undone.state.skills.length, 1);
      }
      assert.strictEqual(yield* fs.readFileString(join(folder, "SKILL.md")), bytes);
      assert.strictEqual(
        (yield* prepareSetupUndo(home, applied.operationId)).summary.status,
        "already-undone",
      );
    }).pipe(Effect.provide(libraryLayer(home)), inLibrary(home));
  }).pipe(Effect.provide(skitLayer)),
);
