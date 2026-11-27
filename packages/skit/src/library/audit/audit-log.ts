import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { LibraryAuditEvent } from "./contracts.js";
export { LibraryAuditChange, LibraryAuditEvent } from "./contracts.js";
import { LibraryAuditInvalid } from "./failures.js";
export { LibraryAuditInvalid } from "./failures.js";
import { libraryDatabasePath, withLibraryDatabase } from "../database.js";

/** Read completed action events; Pending operations keep their event private. */
const loadLibraryAudit = Effect.fn("LibraryAudit.load")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    document: string;
  }>`SELECT document FROM library_audit_events AS events
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(events.operation_ids) AS associated
      JOIN library_operations AS operations ON operations.operation_id = associated.value
      WHERE json_extract(operations.document, '$._tag') = 'Pending'
    )
    ORDER BY sequence`;
  return yield* Effect.forEach(rows, (row, index) =>
    Schema.decodeEffect(Schema.fromJsonString(LibraryAuditEvent))(row.document).pipe(
      Effect.mapError(
        (failure) =>
          new LibraryAuditInvalid({
            path,
            line: index + 1,
            reason: { _tag: "SchemaInvalid", failure },
          }),
      ),
    ),
  );
});

export const readLibraryAudit = Effect.fn("LibraryAudit.list")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return [];
  return yield* withLibraryDatabase(path, loadLibraryAudit(path), true);
});
