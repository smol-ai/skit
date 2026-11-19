import { OperationStatus } from "../src/library/store/state-schema.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { readPathEvidence } from "../src/library/folder-evidence.js";
import {
  loadLibrary,
  loadOperations,
  LibraryWriter,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { skitLayer } from "../src/platform/layer.js";
import { libraryLayer } from "./helpers/library-store.js";

it.effect(
  "released completed Undo imports as the target's Undone status and cannot run twice",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-undo-import-" });
      const home = join(root, "home"),
        folder = join(root, "skills", "review");
      const bytes = "Original user bytes.\n";
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(join(folder, "SKILL.md"), bytes);
      const evidence = yield* readPathEvidence(folder);
      if (Option.isNone(evidence)) return assert.fail("Missing original folder");
      const original = yield* loadLibrary(home);
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const second = join(root, "skills", "later");
        yield* fs.makeDirectory(second);
        yield* fs.writeFileString(join(second, "SKILL.md"), "Later user bytes.\n");
        const later = yield* readPathEvidence(second);
        if (Option.isNone(later)) return assert.fail("Missing later folder");
        let stoppedSteps: OperationStatus["steps"] = [];
        const stopped = yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const changed = LibraryWriter.of({
              ...writer,
              settleOperation: (base, reason) =>
                Effect.gen(function* () {
                  stoppedSteps = base.steps;
                  yield* writer.settleOperation(base, reason);
                }),
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
        const beforeUndo = yield* loadLibrary(home);
        let completed: OperationStatus | undefined;
        yield* writeLibrary(
          home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const observed = LibraryWriter.of({
              ...writer,
              settleOperation: (base, reason) =>
                Effect.gen(function* () {
                  if (base.steps.some(({ step }) => step._tag === "Undo") && reason === undefined) {
                    // 0.3.0 kept this finished record. Its executable program isn't read on import.
                    completed = OperationStatus.cases.Done.make({
                      ...base,
                      _tag: "Done",
                      before: recordedLibrary(beforeUndo),
                      after: recordedLibrary(original),
                    });
                  }
                  yield* writer.settleOperation(base, reason);
                }),
            });
            const plan = yield* library.plan(
              { _tag: "Undo", operationId: stopped.operationId },
              { base: yield* library.read },
            );
            yield* library
              .apply({ _tag: "Apply", plan })
              .pipe(Effect.provideService(LibraryWriter, observed));
          }),
          { resume: stopped.operationId },
        );
        assert.ok(completed);
        assert.strictEqual(yield* fs.readFileString(join(folder, "SKILL.md")), bytes);
        const restored = yield* loadLibrary(home);
        const { setup: _setup, kind: _kind, ...fields } = target;
        const released = {
          ...restored,
          operations: yield* Schema.encodeEffect(Schema.Array(OperationStatus))([
            {
              ...fields,
              steps: stoppedSteps,
              before: recordedLibrary(original),
              after: recordedLibrary(beforeUndo),
            },
            completed,
          ]),
        };
        const importedHome = join(root, "imported");
        yield* fs.makeDirectory(importedHome);
        yield* fs.copy(join(home, "removed"), join(importedHome, "removed"));
        const source = JSON.stringify(released);
        yield* fs.writeFileString(join(importedHome, "state.json"), source);
        yield* migrateLocalLibraryState(importedHome);
        const imported = yield* loadOperations(importedHome);
        assert.deepStrictEqual(
          imported.map((row) => [row.operationId, row._tag]),
          [[stopped.operationId, "Undone"]],
        );
        assert.isFalse(Object.hasOwn(imported[0]!.before, "intent"));
        const before = yield* loadLibrary(importedHome);
        yield* Effect.gen(function* () {
          const next = yield* Library.Service;
          const plan = yield* next.plan(
            { _tag: "Undo", operationId: stopped.operationId },
            { base: yield* next.read },
          );
          assert.strictEqual(plan.change.status, "already-undone");
          const result = yield* next.apply({ _tag: "Apply", plan });
          assert.strictEqual(result._tag, "Undo");
          if (result._tag === "Undo") assert.strictEqual(result.result._tag, "AlreadyUndone");
        }).pipe(Effect.provide(libraryLayer(importedHome)));
        assert.deepStrictEqual(yield* loadLibrary(importedHome), before);
        assert.deepStrictEqual(yield* loadOperations(importedHome), imported);
        assert.strictEqual(yield* fs.readFileString(join(folder, "SKILL.md")), bytes);
        assert.strictEqual(
          yield* fs.readFileString(
            join(importedHome, `state.json.v${restored.schemaVersion}.backup-database`),
          ),
          source,
        );
      }).pipe(Effect.provide(libraryLayer(home)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
