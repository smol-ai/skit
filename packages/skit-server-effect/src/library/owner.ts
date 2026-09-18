import { Clock, Effect, Schema } from "effect";
import type { Principal } from "../auth/authentication.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";

const OwnedLibraryRow = Schema.Struct({
  library_id: Schema.String,
  owner_subject_kind: Schema.Literals(["principal", "team"]),
  owner_subject_id: Schema.String,
  current_revision_id: Schema.NullOr(Schema.String),
});

export type OwnedLibrary = typeof OwnedLibraryRow.Type;

export const decodeOwnedLibrary = (row: unknown) =>
  Schema.decodeUnknownEffect(OwnedLibraryRow)(row).pipe(
    Effect.mapError((cause) => new DatabaseError({ operation: "decode default Library", cause })),
  );

export const findOwnedLibrary = Effect.fn("Libraries.findOwned")(function* (options: {
  readonly sql: DatabaseSqlClient;
  readonly principal: Principal;
  readonly create: boolean;
  readonly clock: Clock.Clock;
  readonly randomUUID: () => string;
}) {
  const find = () =>
    options.sql`SELECT library_id, owner_subject_kind, owner_subject_id, current_revision_id
      FROM libraries WHERE owner_subject_kind = 'principal' AND owner_subject_id = ${options.principal.id}`.pipe(
      databaseError("find default Library"),
    );
  let rows = yield* find();
  if (rows.length === 0 && options.create) {
    const now = new Date(yield* options.clock.currentTimeMillis).toISOString();
    const libraryId = `library_${options.randomUUID().replaceAll("-", "")}`;
    yield* options.sql`INSERT OR IGNORE INTO libraries
      (library_id, owner_subject_kind, owner_subject_id, current_revision_id, created_at, updated_at)
      VALUES (${libraryId}, 'principal', ${options.principal.id}, NULL, ${now}, ${now})`.pipe(
      databaseError("create default Library"),
    );
    rows = yield* find();
  }
  return rows[0] === undefined ? undefined : yield* decodeOwnedLibrary(rows[0]);
});
