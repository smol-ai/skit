import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { basename, join } from "node:path";
import { Library } from "../src/library/library.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { LibraryState } from "../src/library/library-state.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { skitLayer } from "../src/platform/layer.js";

const fixture = Effect.fn("test.recoveryOwner.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-recovery-owner-" }),
  );
  const home = join(root, "library");
  const paths = [join(root, "first"), join(root, "second")];
  for (const path of paths) {
    yield* fs.makeDirectory(path);
    yield* fs.writeFileString(join(path, "SKILL.md"), basename(path));
  }
  const layer = Library.layer({ home, routing: { _tag: "None" } });
  const plan = yield* Effect.gen(function* () {
    const owner = yield* Library.Service;
    const folders = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const folder = yield* observePathEvidence(path);
        if (Option.isNone(folder)) return yield* Effect.die("Missing fixture folder");
        return folder.value;
      }),
    );
    const removed = yield* owner.setup([{ _tag: "Remove", folders }], { base: yield* owner.read });
    assert.strictEqual(removed._tag, "Done");
    return yield* owner.plan(
      { _tag: "Restore", operationId: removed.operationId },
      { base: yield* owner.read },
    );
  }).pipe(Effect.provide(layer));
  const read = Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState));
  return { fs, home, paths, plan, layer, read };
});

it.effect(
  "Restore previews are passive and apply records completion without changing selection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.fs.readFileString(join(f.home, "state.json"));
      yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        yield* owner.plan(f.plan.intent, { base: yield* owner.read });
        assert.strictEqual(yield* f.fs.readFileString(join(f.home, "state.json")), before);
        const outcome = yield* owner.apply({ _tag: "Apply", plan: f.plan });
        assert.strictEqual(outcome.result.phase, "restored");
      }).pipe(Effect.provide(f.layer));
      const old = yield* f.read(before);
      const state = yield* f.read(yield* f.fs.readFileString(join(f.home, "state.json")));
      const { operations: _old, ...oldSelection } = old;
      const { operations: _new, ...selection } = state;
      assert.deepStrictEqual(selection, oldSelection);
      const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
        state.operations,
      );
      assert.strictEqual(operations.at(-1)?._tag, "Done");
      assert.strictEqual(operations.at(-1)?.steps[0]?.step._tag, "Restore");
      const restored = operations.at(-1);
      if (!restored) return assert.fail("Missing recorded Restore");
      yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        const undo = yield* owner.plan(
          { _tag: "Undo", operationId: restored.operationId },
          { base: yield* owner.read },
        );
        assert.isAbove(undo.change.conflicts.length, 0);
      }).pipe(Effect.provide(f.layer));
      for (const path of f.paths)
        assert.strictEqual(yield* f.fs.readFileString(join(path, "SKILL.md")), basename(path));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const diverge of [false, true])
  it.effect(
    `recorded Restore ${diverge ? "stops on divergence" : "resumes"} after a filesystem rename`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let interrupted = false;
        const filesystem: FileSystem.FileSystem = {
          ...f.fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* f.fs.rename(from, to);
              if (!interrupted && to === f.paths[0]) {
                interrupted = true;
                return yield* Effect.die("Process exited after restoring first entry");
              }
            }),
        };
        const exit = yield* Effect.exit(
          Effect.flatMap(Library.Service, (owner) =>
            owner.apply({ _tag: "Apply", plan: f.plan }),
          ).pipe(
            Effect.provide(
              f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, filesystem))),
            ),
          ),
        );
        assert.strictEqual(exit._tag, "Failure");
        assert.isTrue(interrupted);
        const recorded = yield* f.read(yield* f.fs.readFileString(join(f.home, "state.json")));
        const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
          recorded.operations,
        );
        const pending = operations.at(-1);
        assert.strictEqual(pending?._tag, "Pending");
        if (!pending) return assert.fail("Missing Pending Restore");
        if (diverge) {
          yield* f.fs.makeDirectory(f.paths[1]!);
          yield* f.fs.writeFileString(join(f.paths[1]!, "SKILL.md"), "user edit");
        }
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;
          assert.deepStrictEqual(owner.startup.finished, diverge ? [] : [pending.operationId]);
          assert.strictEqual(owner.startup.stopped.length, diverge ? 1 : 0);
        }).pipe(Effect.provide(f.layer));
        assert.strictEqual(yield* f.fs.readFileString(join(f.paths[0]!, "SKILL.md")), "first");
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.paths[1]!, "SKILL.md")),
          diverge ? "user edit" : "second",
        );
        if (diverge)
          assert.isTrue(yield* f.fs.exists(f.plan.program.summary.entries[1]!.recoveryPath));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
