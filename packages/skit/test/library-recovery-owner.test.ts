import { loadOperations, loadLibrary } from "../src/library/store/library-store.js";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";

import { describe, assert, it } from "@effect/vitest";

import { Effect, FileSystem, Layer, Option } from "effect";
import { basename, join } from "node:path";
import * as Library from "../src/library/library.js";
import { readPathEvidence } from "../src/library/folder-evidence.js";

import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

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
  const layer = Library.layer({ home, roots: testRoots(home) });
  const plan = yield* Effect.gen(function* () {
    const owner = yield* Library.Service;
    const folders = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const folder = yield* readPathEvidence(path);
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
  return { fs, home, paths, plan, layer };
});

it.effect("restore preview leaves saved Library state unchanged", () =>
  Effect.gen(function* () {
    const f = yield* fixture();

    const before = yield* loadLibrary(f.home);
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;

      yield* owner.plan(f.plan.intent, { base: yield* owner.read });

      assert.deepStrictEqual(yield* loadLibrary(f.home), before);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("restoring files does not advertise an undo of that restore", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      yield* owner.apply({ _tag: "Apply", plan: f.plan });
    }).pipe(Effect.provide(f.layer));

    const operations = yield* loadOperations(f.home);

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
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

describe("skit library recovery restore", () => {
  describe("An interrupted restore does not overwrite a later edit.", () => {
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

            const operations = yield* loadOperations(f.home);
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
  });
});

describe("skit library recovery restore", () => {
  describe("Restore leaves what is enabled unchanged.", () => {
    it.effect("restoring saved files leaves the Library selection unchanged", () =>
      Effect.gen(function* () {
        const f = yield* fixture();

        const before = yield* loadLibrary(f.home);
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;

          const outcome = yield* owner.apply({ _tag: "Apply", plan: f.plan });

          assert.strictEqual(outcome.result.phase, "restored");
        }).pipe(Effect.provide(f.layer));

        const old = before;

        const state = yield* loadLibrary(f.home);

        const oldSelection = old;

        const selection = state;

        assert.deepStrictEqual(selection, oldSelection);

        const operations = yield* loadOperations(f.home);

        assert.strictEqual(operations.at(-1)?._tag, "Done");

        assert.strictEqual(operations.at(-1)?.steps[0]?.step._tag, "Restore");

        for (const path of f.paths)
          assert.strictEqual(yield* f.fs.readFileString(join(path, "SKILL.md")), basename(path));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  });
});

describe("skit library recovery list", () => {
  describe("Listing recovery files leaves those files unchanged.", () => {
    it.effect("recovery listing remains read-only beside malformed change history", () =>
      Effect.gen(function* () {
        const f = yield* fixture();

        const malformed = "{ malformed history\n";

        yield* withLibraryDatabase(
          libraryDatabasePath(f.home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Inject corruption below the schema boundary to exercise the reader.
            yield* sql`PRAGMA ignore_check_constraints=ON`;
            yield* sql`UPDATE library_audit_events SET document = ${malformed}`;
            yield* sql`PRAGMA ignore_check_constraints=OFF`;
          }),
        );

        const state = yield* loadLibrary(f.home);
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;

          const history = yield* Effect.result(owner.history);

          assert.strictEqual(history._tag, "Failure");

          if (history._tag === "Failure")
            assert.strictEqual(history.failure._tag, "LibraryAuditInvalid");

          assert.deepStrictEqual(yield* owner.recovery.list, [f.plan.intent.operationId]);

          yield* withLibraryDatabase(
            libraryDatabasePath(f.home),
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const rows = yield* sql<{
                document: string;
              }>`SELECT document FROM library_audit_events`;
              assert.isTrue(rows.every((row) => row.document === malformed));
            }),
            true,
          );

          assert.deepStrictEqual(yield* loadLibrary(f.home), state);
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  });
});

describe("skit library recovery inspect", () => {
  describe("Recovery can still be inspected when change history is unreadable.", () => {
    it.effect("recovery inspection remains readable beside malformed change history", () =>
      Effect.gen(function* () {
        const f = yield* fixture();

        const malformed = "{ malformed history\n";

        yield* withLibraryDatabase(
          libraryDatabasePath(f.home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Inject corruption below the schema boundary to exercise the reader.
            yield* sql`PRAGMA ignore_check_constraints=ON`;
            yield* sql`UPDATE library_audit_events SET document = ${malformed}`;
            yield* sql`PRAGMA ignore_check_constraints=OFF`;
          }),
        );
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;

          const inspected = yield* owner.recovery.inspect(f.plan.intent.operationId);

          assert.deepStrictEqual(inspected, f.plan.change);
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
  });
});
