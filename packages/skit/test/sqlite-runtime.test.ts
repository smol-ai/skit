import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "../src/platform/layer.js";
import { SqlClient } from "effect/sql";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withDatabaseTransaction,
  withLibraryDatabase,
} from "../src/library/store/database.js";
import { lockFile } from "../src/platform/file-lock.js";

const RuntimeResult = Schema.fromJsonString(
  Schema.Struct({
    rejected: Schema.Boolean,
    collections: Schema.Array(Schema.Struct({ collection_id: Schema.String })),
    skills: Schema.Array(Schema.Struct({ skill_id: Schema.String })),
    integrity: Schema.Array(Schema.Struct({ integrity_check: Schema.String })),
    references: Schema.Array(Schema.Unknown),
  }),
);
const script = fileURLToPath(new URL("./fixtures/sqlite-runtime.ts", import.meta.url));

it.effect(
  "Node and Bun share Library rows, reject missing references and roll back failed writes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sqlite-runtime-" });
      const ids: string[] = [];
      const runs: ReadonlyArray<readonly [string, string, "read" | "write"]> = [
        [process.execPath, "node", "write"],
        ["bun", "reader", "read"],
        ["bun", "bun", "write"],
        [process.execPath, "reader", "read"],
        [process.execPath, "node-again", "write"],
        ["bun", "reader", "read"],
      ];
      for (const [runtime, id, mode] of runs) {
        const before =
          mode === "read" ? yield* fs.readFile(join(home, "library.sqlite")) : undefined;
        const run = spawnSync(runtime, [script, home, id, mode], {
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.strictEqual(run.status, 0, run.stderr);
        if (mode === "write") ids.push(id);
        const value = yield* Schema.decodeEffect(RuntimeResult)(run.stdout);
        assert.isTrue(value.rejected);
        assert.deepStrictEqual(
          value.collections.map((row) => row.collection_id),
          ids.toSorted(),
        );
        assert.deepStrictEqual(
          value.skills.map((row) => row.skill_id),
          ids.toSorted(),
        );
        assert.deepStrictEqual(value.integrity, [{ integrity_check: "ok" }]);
        assert.deepStrictEqual(value.references, []);
        if (before !== undefined)
          assert.deepStrictEqual(yield* fs.readFile(join(home, "library.sqlite")), before);
      }
      assert.isTrue(yield* fs.exists(join(home, "library.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "a Bun reader sees committed WAL rows while a Node writer holds an unfinished transaction",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sqlite-wal-" });
      yield* prepareLibraryDatabase(home, true);
      yield* withLibraryDatabase(
        join(home, "library.sqlite"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA wal_autocheckpoint = 0`;
          yield* sql`INSERT INTO library_collections (collection_id,label) VALUES ('committed','committed')`;
          const unfinished = yield* Effect.result(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO library_collections (collection_id,label) VALUES ('unfinished','unfinished')`;
                const run = spawnSync("bun", [script, home, "reader", "read"], {
                  encoding: "utf8",
                  timeout: 10_000,
                });
                assert.strictEqual(run.status, 0, run.stderr);
                const value = yield* Schema.decodeEffect(RuntimeResult)(run.stdout);
                assert.isTrue(value.rejected);
                assert.deepStrictEqual(value.collections, [{ collection_id: "committed" }]);
                assert.deepStrictEqual(value.skills, []);
                return yield* Effect.fail("rollback unfinished write");
              }),
            ),
          );
          assert.strictEqual(unfinished._tag, "Failure");
          assert.deepStrictEqual(yield* sql`SELECT collection_id FROM library_collections`, [
            { collection_id: "committed" },
          ]);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("a write within a read transaction takes the home lock and uses a write connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sqlite-read-scope-" });
    yield* prepareLibraryDatabase(home, true);
    const path = libraryDatabasePath(home);

    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const reader = yield* SqlClient.SqlClient;
        yield* reader.withTransaction(
          Effect.gen(function* () {
            assert.deepStrictEqual(
              yield* reader`SELECT collection_id FROM library_collections`,
              [],
            );
            yield* withDatabaseTransaction(
              home,
              Effect.gen(function* () {
                const writer = yield* SqlClient.SqlClient;
                assert.notStrictEqual(writer, reader);
                const locked = yield* Effect.flip(
                  Effect.scoped(lockFile(join(home, "lock.sqlite"))),
                );
                assert.strictEqual(locked._tag, "FileLockBusy");
                yield* writer`INSERT INTO library_collections (collection_id,label) VALUES ('kept','kept')`;
                const stopped = yield* Effect.flip(
                  withDatabaseTransaction(
                    home,
                    Effect.gen(function* () {
                      const nested = yield* SqlClient.SqlClient;
                      assert.strictEqual(nested, writer);
                      yield* nested`INSERT INTO library_collections (collection_id,label) VALUES ('reverted','reverted')`;
                      return yield* Effect.fail("roll back the savepoint");
                    }),
                  ),
                );
                assert.strictEqual(stopped, "roll back the savepoint");
              }),
            );
            assert.deepStrictEqual(
              yield* reader`SELECT collection_id FROM library_collections`,
              [],
            );
          }),
        );
        assert.deepStrictEqual(yield* reader`SELECT collection_id FROM library_collections`, [
          { collection_id: "kept" },
        ]);
      }),
      true,
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
