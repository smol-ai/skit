import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { basename, join } from "node:path";
import * as Library from "../src/library/library.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { LibraryState } from "../src/library/library-state.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { inspectRecoveryOperation } from "../src/library/internal/recovery/moves.js";
import { canonicalJson } from "../src/shared/json.js";
import { skitLayer } from "../src/platform/layer.js";

const fixture = Effect.fn("test.undoRecovery.fixture")(function* (reconstruct = false) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-undo-recorded-" }),
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
    if (reconstruct) {
      const request = yield* localImportRequest(paths[0]!, "2026-11-05T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Missing reconstruction source");
      yield* owner.import.collection(request.value);
    }
    const folders = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const evidence = yield* observePathEvidence(path);
        if (Option.isNone(evidence)) return yield* Effect.die("Missing fixture folder");
        return evidence.value;
      }),
    );
    const removed = yield* owner.setup([{ _tag: "Remove", folders }], { base: yield* owner.read });
    assert.strictEqual(removed._tag, "Done");
    if (reconstruct) {
      const saved = yield* inspectRecoveryOperation(home, removed.operationId);
      yield* fs.remove(saved.entries[0]!.recoveryPath, { recursive: true });
    }
    return yield* owner.plan(
      { _tag: "Undo", operationId: removed.operationId },
      { base: yield* owner.read },
    );
  }).pipe(Effect.provide(layer));
  const statePath = join(home, "state.json");
  const read = Effect.flatMap(
    fs.readFileString(statePath),
    Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState)),
  );
  const operations = Effect.flatMap(read, (state) =>
    Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(state.operations),
  );
  return { fs, home, paths, plan, layer, read, operations, statePath };
});

it.effect("Undo review is passive and stale approval cannot record or restore anything", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.fs.readFileString(f.statePath);
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      yield* owner.plan(f.plan.intent, { base: yield* owner.read });
      assert.strictEqual(yield* f.fs.readFileString(f.statePath), before);
      yield* f.fs.makeDirectory(f.paths[1]!);
      yield* f.fs.writeFileString(join(f.paths[1]!, "SKILL.md"), "user edit");
      const failure = yield* Effect.flip(owner.apply({ _tag: "Apply", plan: f.plan }));
      assert.strictEqual(failure._tag, "Library.StalePlan");
      assert.strictEqual(yield* f.fs.readFileString(f.statePath), before);
      assert.isFalse(yield* f.fs.exists(f.paths[0]!));
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["record", "rename", "copy", "completion"] as const)
  for (const diverge of boundary === "rename" || boundary === "copy" ? [false, true] : [false])
    it.effect(`Undo ${diverge ? "stops on divergence" : "resumes"} after ${boundary}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(boundary === "copy");
        let interrupted = false;
        const faultFs: FileSystem.FileSystem = {
          ...f.fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (boundary === "completion" && to === f.statePath) {
                const next = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
                  yield* f.fs.readFileString(from),
                ).pipe(Effect.orDie);
                const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
                  next.operations,
                ).pipe(Effect.orDie);
                const last = operations.at(-1);
                if (
                  last?._tag === "Pending" &&
                  last.steps[0]?.step._tag === "Undo" &&
                  last.steps[0].status === "Done"
                ) {
                  interrupted = true;
                  return yield* Effect.die("Process exited before Undo checkpoint");
                }
              }
              yield* f.fs.rename(from, to);
              if (interrupted) return;
              if ((boundary === "rename" || boundary === "copy") && to === f.paths[0]) {
                interrupted = true;
                return yield* Effect.die("Process exited after first restore rename");
              }
              if (boundary === "record" && to === f.statePath) {
                const last = (yield* f.operations.pipe(Effect.orDie)).at(-1);
                if (last?._tag === "Pending" && last.steps[0]?.step._tag === "Undo") {
                  interrupted = true;
                  return yield* Effect.die("Process exited after recording Undo");
                }
              }
            }),
        };
        const exit = yield* Effect.exit(
          Effect.flatMap(Library.Service, (owner) =>
            owner.apply({ _tag: "Apply", plan: f.plan }),
          ).pipe(
            Effect.provide(
              f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, faultFs))),
            ),
          ),
        );
        assert.strictEqual(exit._tag, "Failure");
        assert.isTrue(interrupted);
        const pending = (yield* f.operations).at(-1);
        assert.strictEqual(pending?._tag, "Pending");
        if (!pending) return assert.fail("Missing recorded Undo");
        if (diverge && boundary === "copy") {
          // Identical bytes at a new inode are not the entry Undo recorded before its rename.
          const owned = join(f.home, "first-restored-copy");
          yield* f.fs.rename(f.paths[0]!, owned);
          yield* f.fs.copy(owned, f.paths[0]!);
        } else if (diverge) {
          yield* f.fs.makeDirectory(f.paths[1]!);
          yield* f.fs.writeFileString(join(f.paths[1]!, "SKILL.md"), "user edit");
        }
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;
          assert.deepStrictEqual(
            owner.startup.finished,
            diverge ? [] : [pending.operationId],
            canonicalJson(owner.startup.stopped),
          );
          assert.strictEqual(owner.startup.stopped.length, diverge ? 1 : 0);
          for (const path of f.paths) {
            if (diverge && boundary === "copy" && path === f.paths[1]) {
              assert.isFalse(yield* f.fs.exists(path));
              continue;
            }
            assert.strictEqual(
              yield* f.fs.readFileString(join(path, "SKILL.md")),
              diverge && path === f.paths[1] ? "user edit" : basename(path),
            );
          }
          if (!diverge) {
            yield* f.fs.writeFileString(join(f.paths[0]!, "SKILL.md"), "later edit");
            const before = yield* f.fs.readFileString(f.statePath);
            const again = yield* owner.plan(f.plan.intent, { base: yield* owner.read });
            assert.strictEqual(
              (yield* owner.apply({ _tag: "Apply", plan: again })).result._tag,
              "AlreadyUndone",
            );
            assert.strictEqual(yield* f.fs.readFileString(f.statePath), before);
            assert.strictEqual(
              yield* f.fs.readFileString(join(f.paths[0]!, "SKILL.md")),
              "later edit",
            );
          }
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
