import { Effect } from "effect";
import { SqlClient } from "effect/sql";

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

/** Raw programs from unreleased dev builds have no history or recovery reader. */
export const removeLegacyPrograms = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE library_history_compaction (id INTEGER PRIMARY KEY CHECK(id=1)) STRICT`;
  yield* sql`INSERT INTO library_history_compaction SELECT 1 WHERE EXISTS(SELECT 1 FROM library_legacy_operations)`;
  yield* sql`ALTER TABLE library_legacy_operations DROP COLUMN document`;
});
