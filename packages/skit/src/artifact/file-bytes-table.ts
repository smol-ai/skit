import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const createFileBytesTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE file_bytes(hash TEXT PRIMARY KEY,size INTEGER NOT NULL CHECK(size>=0 AND size<=9007199254740991)) STRICT`;
});

/** Recovery may read complete bytes before the writer can advance an older database. */
export const fileBytesAvailable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (
    (yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='file_bytes'`).length > 0
  );
});
