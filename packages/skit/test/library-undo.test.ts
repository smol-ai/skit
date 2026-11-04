import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { Library } from "../src/library/library.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { skitLayer } from "../src/platform/layer.js";
import { libraryLayer } from "./helpers/library-store.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-undo-" });
  const home = join(root, "home");
  const folder = join(root, "skills", "review");
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(join(folder, "SKILL.md"), "Original review bytes.\n");
  const evidence = yield* observePathEvidence(folder);
  if (Option.isNone(evidence)) return yield* Effect.die("No original folder evidence");
  const operation = yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    return yield* library.setup([{ _tag: "Remove", folders: [evidence.value] }], {
      base: yield* library.read,
    });
  }).pipe(Effect.provide(libraryLayer(home)));
  assert.strictEqual(operation._tag, "Done");
  return { fs, home, folder, operationId: operation.operationId };
});

it.effect(
  "a serialized owner plan restores the original files and repeats without restoring again",
  () =>
    Effect.gen(function* () {
      const { fs, home, folder, operationId } = yield* fixture;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(
          { _tag: "Undo", operationId },
          { base: yield* library.read },
        );
        const serialized = JSON.stringify(plan);
        const decoded = yield* Schema.decodeUnknownEffect(Library.UndoPlan)(JSON.parse(serialized));
        assert.strictEqual(decoded.change.status, "ready");
        assert.isFalse(yield* fs.exists(folder));
        assert.isFalse(yield* fs.exists(join(home, "removed", plan.backupId)));
        const result = yield* library.apply(decoded);
        assert.strictEqual(result._tag, "Undone");
        assert.strictEqual(
          yield* fs.readFileString(join(folder, "SKILL.md")),
          "Original review bytes.\n",
        );
        const undoPath = join(home, "removed", operationId, "undo");
        const attemptName = (yield* fs.readDirectory(undoPath)).find(
          (name) => !name.endsWith(".done.json"),
        );
        if (attemptName === undefined) return yield* Effect.die("Missing durable inverse");
        const attempt = JSON.parse(yield* fs.readFileString(join(undoPath, attemptName)));
        assert.strictEqual(attempt.schemaVersion, 3);
        assert.isFalse("settingsBefore" in attempt);
        assert.isFalse("settingsAfter" in attempt);
        assert.isFalse(yield* fs.exists(join(home, "machine.json")));
        yield* fs.writeFileString(join(folder, "SKILL.md"), "Later independent bytes.\n");
        const repeated = yield* library.plan(
          { _tag: "Undo", operationId },
          { base: yield* library.read },
        );
        assert.strictEqual((yield* library.apply(repeated))._tag, "AlreadyUndone");
        assert.strictEqual(
          yield* fs.readFileString(join(folder, "SKILL.md")),
          "Later independent bytes.\n",
        );
      }).pipe(Effect.provide(libraryLayer(home)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an occupied original refuses the displayed plan before any undo effect", () =>
  Effect.gen(function* () {
    const { fs, home, folder, operationId } = yield* fixture;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const plan = yield* library.plan(
        { _tag: "Undo", operationId },
        { base: yield* library.read },
      );
      const bytes = yield* fs.readFileString(join(home, "state.json"));
      yield* fs.makeDirectory(folder);
      yield* fs.writeFileString(join(folder, "independent.txt"), "User's newer folder.\n");
      assert.strictEqual((yield* Effect.flip(library.apply(plan)))._tag, "Library.StalePlan");
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
      assert.strictEqual(
        yield* fs.readFileString(join(folder, "independent.txt")),
        "User's newer folder.\n",
      );
      assert.isFalse(yield* fs.exists(join(home, "removed", plan.backupId)));
      assert.isFalse(yield* fs.exists(join(home, "removed", operationId, "undo")));
    }).pipe(Effect.provide(libraryLayer(home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "editing serialized next-state or recovery destinations cannot redirect an owner apply",
  () =>
    Effect.gen(function* () {
      const { fs, home, folder, operationId } = yield* fixture;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(
          { _tag: "Undo", operationId },
          { base: yield* library.read },
        );
        const bytes = yield* fs.readFileString(join(home, "state.json"));
        const forged = {
          ...plan,
          change: {
            ...plan.change,
            next: { ...plan.change.next, repositories: [{ root: "/unreviewed", enabled: [] }] },
          },
        };
        assert.strictEqual((yield* Effect.flip(library.apply(forged)))._tag, "Library.StalePlan");
        assert.strictEqual(
          (yield* Effect.flip(library.apply({ ...plan, backupId: "../../outside" })))._tag,
          "RecoveryInvalid",
        );
        assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
        assert.isFalse(yield* fs.exists(folder));
        assert.isFalse(yield* fs.exists(join(home, "removed", plan.backupId)));
      }).pipe(Effect.provide(libraryLayer(home)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
