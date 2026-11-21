import { saveLegacyHistory } from "../src/library/store/legacy-history.js";
import { saveLibrary } from "./helpers/library-store.js";
import { database012 } from "./helpers/library-database-012.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { skitLayer } from "../src/platform/layer.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { loadOperations, loadOperationHistory } from "../src/library/store/library-store.js";
import {
  libraryDatabasePath,
  migrateLibraryDatabase,
  withLibraryDatabase,
} from "../src/library/store/database.js";
import { canonicalJson, JsonObject } from "../src/shared/json.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-legacy-history-" });
  const state = emptyLibraryState();
  const before = recordedLibrary(state);
  const done = {
    _tag: "Done",
    operationId: makeOperationId(),
    before,
    after: before,
    steps: [
      {
        step: {
          _tag: "Apply",
          before: state,
          next: state,
          unknownProgram: { kept: [null, false] },
        },
        before: [],
        after: [],
        status: "Done",
        extraEvidence: { original: true },
      },
    ],
    extension: { original: [3, 2, 1] },
  };
  const pending = { _tag: "Pending", operationId: makeOperationId(), before, steps: [] };
  const operations = [done, pending, { ...done, operationId: makeOperationId() }];
  yield* saveLibrary(home, state);
  const path = libraryDatabasePath(home);
  yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* saveLegacyHistory(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(JsonObject)))(
          JSON.stringify(operations),
        ),
        null,
      );
      yield* sql`INSERT INTO library_operations(position,operation_id,kind,document)
        VALUES (0,${pending.operationId},'apply',${JSON.stringify(pending)})`;
    }),
  );
  return { home, path, operations };
});

it.effect(
  "legacy history keeps summaries and order without raw programs while recovery sees only live records",
  () =>
    Effect.gen(function* () {
      const { home, path, operations } = yield* prepared;
      assert.deepStrictEqual(
        (yield* loadOperations(home)).map((row) => row.operationId),
        [operations[1]!.operationId],
      );
      const history = yield* loadOperationHistory(home);
      assert.deepStrictEqual(
        history.map((row) => [row.operationId, row._tag]),
        operations.map((row) => [row.operationId, row._tag]),
      );
      assert.deepStrictEqual(history[0]?.steps[0]?.step, { _tag: "Apply" });
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const columns = yield* sql<{
            name: string;
          }>`PRAGMA table_info(library_legacy_operations)`;
          assert.isFalse(columns.some((column) => column.name === "document"));
        }),
        true,
      );
      yield* migrateLocalLibraryState(home);
      assert.strictEqual(canonicalJson(yield* loadOperationHistory(home)), canonicalJson(history));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("existing dev databases discard raw programs and reclaim their pages", () =>
  Effect.gen(function* () {
    const { home, path } = yield* prepared;
    const history = yield* loadOperationHistory(home);
    yield* database012(home);
    const fs = yield* FileSystem.FileSystem;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`ALTER TABLE library_legacy_operations ADD COLUMN document TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(document))`;
        yield* sql`UPDATE library_legacy_operations SET document=${JSON.stringify({ raw: "x".repeat(3_000_000) })}`;
        yield* sql`DROP TABLE library_history_compaction`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id>=11`;
      }),
    );
    const before = (yield* fs.stat(path)).size;
    // Commit the migration with compaction pending, then inject a cleanup SQL failure.
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateLibraryDatabase(path);
        yield* sql`CREATE TRIGGER refuse_compaction_completion BEFORE DELETE ON library_history_compaction BEGIN SELECT RAISE(ABORT,'cleanup failed'); END`;
      }),
    );
    // A cleanup SQL failure must not block preparing the Library or lose the retry marker.
    yield* migrateLocalLibraryState(home);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT id FROM library_history_compaction`).length, 1);
        yield* sql`DROP TRIGGER refuse_compaction_completion`;
      }),
    );
    yield* migrateLocalLibraryState(home);
    const after = (yield* fs.stat(path)).size;
    assert.isTrue(Number(before) - Number(after) > 8_000_000);
    assert.strictEqual(canonicalJson(yield* loadOperationHistory(home)), canonicalJson(history));
    yield* migrateLocalLibraryState(home);
    assert.strictEqual((yield* fs.stat(path)).size, after);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
