import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { readPathEvidence } from "../src/library/folder-evidence.js";
import {
  loadLibrary,
  loadOperations,
  LibraryWriter,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { skitLayer } from "../src/platform/layer.js";
import { libraryLayer } from "./helpers/library-store.js";

it.effect("a completed Undo persists the target's Undone status and cannot run twice", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-undo-once-" });
    const home = join(root, "home"),
      folder = join(root, "skills", "review");
    const bytes = "Original user bytes.\n";
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(join(folder, "SKILL.md"), bytes);
    const evidence = yield* readPathEvidence(folder);
    if (Option.isNone(evidence)) return assert.fail("Missing original folder");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const second = join(root, "skills", "later");
      yield* fs.makeDirectory(second);
      yield* fs.writeFileString(join(second, "SKILL.md"), "Later user bytes.\n");
      const later = yield* readPathEvidence(second);
      if (Option.isNone(later)) return assert.fail("Missing later folder");
      const stopped = yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const changed = LibraryWriter.of({
            ...writer,
            saveOperation: (next, base, state) =>
              Effect.gen(function* () {
                yield* writer.saveOperation(next, base, state);
                if (
                  next.steps[0]?.status === "Done" &&
                  next.steps[1]?.status === "Pending" &&
                  (yield* fs.exists(second))
                )
                  yield* fs.remove(second, { recursive: true });
              }),
          });
          return yield* library
            .setup(
              [
                { _tag: "Remove", folders: [evidence.value] },
                { _tag: "Remove", folders: [later.value] },
              ],
              { base: yield* library.read },
            )
            .pipe(Effect.provideService(LibraryWriter, changed));
        }),
      );
      assert.strictEqual(stopped._tag, "Stopped");
      const target = (yield* loadOperations(home)).find(
        (row) => row.operationId === stopped.operationId,
      );
      if (target?._tag !== "Stopped") return assert.fail("Missing stopped target");
      const firstPlan = yield* library.plan(
        { _tag: "Undo", operationId: stopped.operationId },
        { base: yield* library.read },
      );
      yield* library.apply({ _tag: "Apply", plan: firstPlan });
      assert.strictEqual(yield* fs.readFileString(join(folder, "SKILL.md")), bytes);
      const settled = yield* loadOperations(home);
      assert.deepStrictEqual(
        settled.map((row) => [row.operationId, row._tag]),
        [[stopped.operationId, "Undone"]],
      );
      const before = yield* loadLibrary(home);
      const plan = yield* library.plan(
        { _tag: "Undo", operationId: stopped.operationId },
        { base: yield* library.read },
      );
      assert.strictEqual(plan.change.status, "already-undone");
      const result = yield* library.apply({ _tag: "Apply", plan });
      assert.strictEqual(result._tag, "Undo");
      if (result._tag === "Undo") assert.strictEqual(result.result._tag, "AlreadyUndone");
      assert.deepStrictEqual(yield* loadLibrary(home), before);
      assert.deepStrictEqual(yield* loadOperations(home), settled);
      assert.strictEqual(yield* fs.readFileString(join(folder, "SKILL.md")), bytes);
    }).pipe(Effect.provide(libraryLayer(home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
