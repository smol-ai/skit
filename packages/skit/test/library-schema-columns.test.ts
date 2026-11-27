import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/database.js";
import { writeLibrary, LibraryWriter } from "../src/library/store/library-store.js";
import { readCatalogue } from "../src/library/store/catalogue.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { skitLayer } from "../src/platform/layer.js";
import { saveLibrary } from "./helpers/library-store.js";
import { declaredFixture } from "./helpers/library-values.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-schema-columns-" });
  const { state } = yield* declaredFixture;
  yield* saveLibrary(home, state);
  return { home, path: libraryDatabasePath(home) };
});

const snapshot = (path: string) =>
  withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schema = yield* sql<{
        name: string;
        sql: string | null;
      }>`SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name`;
      const rows = yield* Effect.forEach(schema, (table) =>
        Effect.gen(function* () {
          return [table.name, yield* sql`SELECT * FROM ${sql(table.name)} ORDER BY rowid`];
        }),
      );
      return { schema, rows };
    }),
    true,
  );

it.effect(
  "known wrong types and excess write properties fail typed without changing rows, revision or audit",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const before = yield* readCatalogue(f.home);
      const audit = yield* readLibraryAudit(f.home);
      for (const [key, value] of [
        ["label", 123],
        ["future", { kept: true }],
      ] satisfies ReadonlyArray<readonly [string, unknown]>) {
        const next = structuredClone(before.value);
        Object.defineProperty(next.collections[0]!, key, {
          value,
          enumerable: true,
          configurable: true,
        });
        yield* writeLibrary(
          f.home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const revision = yield* writer.revision;
            const result = yield* Effect.result(writer.saveCatalogue(next, before.value, revision));
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.strictEqual(result.failure._tag, "InvalidLibraryState");
            assert.strictEqual(yield* writer.revision, revision);
          }),
        );
        assert.deepStrictEqual(yield* readCatalogue(f.home), before);
        assert.deepStrictEqual(yield* readLibraryAudit(f.home), audit);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "an excess property in a declared JSON column fails on read instead of being stripped",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient)`UPDATE library_imports SET source_identity=json_set(source_identity,'$.future',true)`;
        }),
      );
      const before = yield* snapshot(f.path);
      const result = yield* Effect.result(readCatalogue(f.home));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidLibraryState");
      assert.deepStrictEqual(yield* snapshot(f.path), before);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
