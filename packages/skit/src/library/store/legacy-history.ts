import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { InvalidLibraryState } from "../failures.js";
import { OperationId } from "../entity-ids.js";
import { OperationSummary } from "./state-schema.js";
import { JsonObject } from "../../shared/json.js";
import { sha256Hash } from "../../shared/hash.js";
import { libraryDatabasePath, withLibraryDatabase } from "./database.js";
import { withLibraryStateReplacement } from "./writer-lock.js";

export const createLegacyHistoryTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE library_legacy_operations (position INTEGER PRIMARY KEY CHECK(position>=0),operation_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('Done','Pending','Stopped','Undone')),document TEXT NOT NULL CHECK(json_valid(document)),summary TEXT CHECK(summary IS NULL OR json_valid(summary)),CHECK((status='Done')=(summary IS NOT NULL))) STRICT`;
  yield* sql`CREATE TABLE library_legacy_history_import (id INTEGER PRIMARY KEY CHECK(id=1),source_hash TEXT) STRICT`;
});

/** Allow incomplete historical records without inventing a valid setup summary. */
export const prepareLegacyHistorySummaries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE library_legacy_operations RENAME TO library_legacy_operations_previous`;
  yield* sql`CREATE TABLE library_legacy_operations (position INTEGER PRIMARY KEY CHECK(position>=0),operation_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('Done','Pending','Stopped','Undone')),document TEXT NOT NULL CHECK(json_valid(document)),summary TEXT CHECK(summary IS NULL OR json_valid(summary)),CHECK(summary IS NULL OR status='Done')) STRICT`;
  yield* sql`INSERT INTO library_legacy_operations SELECT * FROM library_legacy_operations_previous`;
  yield* sql`DROP TABLE library_legacy_operations_previous`;
});

const LegacyOperation = Schema.Struct({
  _tag: Schema.Literals(["Done", "Pending", "Stopped", "Undone"]),
  operationId: OperationId,
});

/** Old completed programs supply historical evidence only, never executable instructions. */
const legacyOperationSummary = Effect.fn("Library.legacyOperationSummary")(function* (
  value: JsonObject,
) {
  const document = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ steps: Schema.Array(JsonObject) }),
  )(value);
  const steps = yield* Effect.forEach(document.steps, (row) =>
    Effect.gen(function* () {
      const record = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          step: JsonObject,
          before: Schema.Array(JsonObject),
          after: Schema.Array(JsonObject),
          status: Schema.Literals(["Pending", "Done"]),
        }),
      )(row);
      return {
        step: record.step,
        before: record.before.filter((item) => item._tag !== "Retained"),
        after: record.after.filter((item) => item._tag !== "Retained"),
        status: record.status,
      };
    }),
  );
  return yield* Schema.decodeUnknownEffect(OperationSummary.cases.Done)({ ...value, steps });
});

/** The source import owns this transaction; completed dev programs supply summaries only. */
export const saveLegacyHistory = Effect.fn("Library.saveLegacyHistory")(function* (
  operations: readonly JsonObject[],
  hash: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [position, document] of operations.entries()) {
    const header = yield* Schema.decodeUnknownEffect(LegacyOperation)(document);
    const summary =
      header._tag === "Done"
        ? yield* legacyOperationSummary(document).pipe(
            Effect.catchTag("SchemaError", () => Effect.succeed(undefined)),
          )
        : undefined;
    yield* sql`INSERT INTO library_legacy_operations(position,operation_id,status,summary) VALUES(${position},${header.operationId},${header._tag},${summary === undefined ? null : JSON.stringify(summary)})`;
  }
  yield* sql`INSERT INTO library_legacy_history_import(id,source_hash) VALUES(1,${hash})`;
});

/** Import immutable source evidence once, including homes imported before completed records were kept. */
export const importLegacyHistory = Effect.fn("Library.importLegacyHistory")(
  function* (home: string) {
    const path = libraryDatabasePath(home);
    const fs = yield* FileSystem.FileSystem;
    const imported = yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql`SELECT id FROM library_legacy_history_import WHERE id=1`).length > 0;
      }),
      true,
    );
    if (imported) return;
    yield* withLibraryStateReplacement(
      home,
      withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if ((yield* sql`SELECT id FROM library_legacy_history_import WHERE id=1`).length)
                return;
              const source = (yield* sql<{
                backup: string | null;
                hash: string | null;
              }>`SELECT backup,hash FROM library_import WHERE source='state.json'`)[0];
              if (!source) return;
              let operations: JsonObject[] = [];
              if (source.backup !== null) {
                const text = yield* fs.readFileString(source.backup);
                if ((yield* sha256Hash(new TextEncoder().encode(text))) !== source.hash)
                  return yield* new InvalidLibraryState({
                    path,
                    reason: { _tag: "InvalidData", issue: "Legacy history backup changed" },
                  });
                const document = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(JsonObject),
                )(text);
                operations = [
                  ...(yield* Schema.decodeUnknownEffect(Schema.Array(JsonObject))(
                    document.operations ?? [],
                  )),
                ];
              }
              yield* saveLegacyHistory(operations, source.hash);
            }),
          );
        }),
      ),
    );
  },
  (effect, home) =>
    effect.pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(
          new InvalidLibraryState({
            path: libraryDatabasePath(home),
            reason: { _tag: "SchemaInvalid", failure },
          }),
        ),
      ),
    ),
);

/** Reading history never reopens a source backup or makes a legacy program executable. */
export const loadLegacyHistory = Effect.fn("Library.loadLegacyHistory")(function* (home: string) {
  const path = libraryDatabasePath(home);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return [];
  return yield* withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        operation_id: string;
        status: string;
        summary: string | null;
      }>`SELECT operation_id,status,summary FROM library_legacy_operations ORDER BY position`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const header = yield* Schema.decodeUnknownEffect(LegacyOperation)({
            _tag: row.status,
            operationId: row.operation_id,
          });
          const id = header.operationId;
          const summary =
            row.summary === null
              ? undefined
              : yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(OperationSummary.cases.Done),
                )(row.summary);
          if (
            (row.status !== "Done" && summary !== undefined) ||
            (summary !== undefined && summary.operationId !== id)
          )
            return yield* new InvalidLibraryState({
              path,
              reason: { _tag: "InvalidData", issue: "Legacy history identity differs" },
            });
          return {
            id,
            summary,
          };
        }),
      );
    }),
    true,
  ).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );
});

/** Raw programs from unreleased dev builds have no history or recovery reader. */
export const removeLegacyPrograms = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE library_history_compaction (id INTEGER PRIMARY KEY CHECK(id=1)) STRICT`;
  yield* sql`INSERT INTO library_history_compaction SELECT 1 WHERE EXISTS(SELECT 1 FROM library_legacy_operations)`;
  yield* sql`ALTER TABLE library_legacy_operations DROP COLUMN document`;
});
