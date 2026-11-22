import { Context, Effect, FileSystem, Option, Schema } from "effect";
import { InvalidLibraryState, LibrarySqlError } from "../failures.js";
import { Migrator, SqlClient } from "effect/sql";
import { join, resolve } from "node:path";

import { createInventoryTables } from "./inventory-rows.js";
import { createLibraryTables, createMachineTables } from "./tables.js";
import { withLibraryStateReplacement } from "./writer-lock.js";
import { syncPaths } from "../../platform/atomic-write.js";
import { sqliteLayer } from "../../platform/sqlite.js";
import { createAuthorStateTables } from "../../author/state-tables.js";
import { createFileBytesTable } from "../../artifact/file-bytes-table.js";
import {
  createAuthorHistoryTables,
  createAuthorMetadataTables,
} from "../../author/history-tables.js";

export const libraryDatabasePath = (home: string) => join(resolve(home), "library.sqlite");

type DatabaseMode = "read" | "write" | "locked-write";

class LibraryDatabase extends Context.Service<
  LibraryDatabase,
  { readonly path: string; readonly sql: SqlClient.SqlClient; readonly mode: DatabaseMode }
>()("skit/library/LibraryDatabase") {}

export const currentLibraryTransaction = (home: string) =>
  Effect.gen(function* () {
    const current = Option.getOrUndefined(yield* Effect.serviceOption(LibraryDatabase));
    if (current?.path !== libraryDatabasePath(home)) return undefined;
    const transaction = yield* Effect.serviceOption(current.sql.transactionService);
    return Option.isSome(transaction) ? current : undefined;
  });

const openLibraryDatabase = <A, E, R>(
  path: string,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  mode: DatabaseMode,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (mode !== "read") {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.chmod(path, 0o600);
        yield* sql`PRAGMA synchronous = FULL`;
      }
      return yield* program.pipe(Effect.provideService(LibraryDatabase, { path, sql, mode }));
    }).pipe(Effect.provide(sqliteLayer({ filename: path, readonly: mode === "read" }))),
  );

/** Nested reads can see the current writer's uncommitted rows. */
export const withLibraryDatabase = <A, E, R>(
  path: string,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  readonly = false,
) =>
  Effect.gen(function* () {
    const current = Option.getOrUndefined(yield* Effect.serviceOption(LibraryDatabase));
    if (current?.path === path && (readonly || current.mode !== "read"))
      return yield* program.pipe(Effect.provideService(SqlClient.SqlClient, current.sql));
    return yield* openLibraryDatabase(path, program, readonly ? "read" : "write");
  }).pipe(
    Effect.catchTag("SqlError", (cause) => Effect.fail(new LibrarySqlError({ path, cause }))),
  );

// The ordered registry is the authority for both execution and readiness validation.
// Keep it lazy because table owners also use the scoped database connection functions above.
const libraryMigrations = () => ({
  "001_library": Effect.gen(function* () {
    yield* createLibraryTables;
    yield* createMachineTables;
    yield* createInventoryTables;
    yield* createAuthorStateTables;
    yield* createAuthorHistoryTables;
    yield* createAuthorMetadataTables;
    yield* createFileBytesTable;
  }),
});

/** Schema changes load only the owner rows whose layout changes; never legacy files. */
export const migrateLibraryDatabase = Effect.fn("Library.migrateDatabase")(function* (
  path: string,
) {
  const definitions = libraryMigrations();
  yield* Migrator.make({})({
    loader: Migrator.fromRecord(definitions),
  }).pipe(
    Effect.catchTag("MigrationError", (cause) => Effect.fail(new LibrarySqlError({ path, cause }))),
  );
  // The runner can return after a ledger constraint without applying pending migrations.
  if (!(yield* databaseIsCurrent(path)))
    return yield* new InvalidLibraryState({
      path,
      reason: { _tag: "InvalidData", issue: "Database migration did not finish" },
    });
});

const databaseIsCurrent = Effect.fn("Library.databaseIsCurrent")(function* (path: string) {
  const migrations = Object.keys(libraryMigrations())
    .map((key) => {
      const separator = key.indexOf("_");
      return { id: Number(key.slice(0, separator)), name: key.slice(separator + 1) };
    })
    .sort((left, right) => left.id - right.id);
  const currentMigration = migrations.at(-1)?.id ?? 0;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String })),
  )(yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  const newest = rows.at(-1)?.migration_id ?? 0;
  if (newest > currentMigration)
    return yield* new InvalidLibraryState({
      path,
      reason: {
        _tag: "NewerDatabaseMigration",
        databasePath: path,
        migration: newest,
        supported: currentMigration,
      },
    });
  if (
    rows.length === 0 ||
    rows.length > migrations.length ||
    rows.some(
      (row, index) =>
        row.migration_id !== migrations[index]?.id || row.name !== migrations[index]?.name,
    )
  )
    return yield* new InvalidLibraryState({
      path,
      reason: {
        _tag: "InvalidData",
        issue: "Unsupported unreleased Library database format",
      },
    });
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(library_enabled)`;
  if (!columns.some((column) => column.name === "item_key"))
    return yield* new InvalidLibraryState({
      path,
      reason: {
        _tag: "InvalidData",
        issue: "Unsupported unreleased Library enabled-row format",
      },
    });
  return rows.length === migrations.length;
});

/** Create the shared schema or verify the existing database version. */
export const prepareLibraryDatabase = Effect.fn("Library.prepareDatabase")(function* (
  home: string,
  create = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(home);
  const path = libraryDatabasePath(root);
  const exists = yield* fs.exists(path);
  if (!exists && !create) return false;
  if (exists) {
    const ready = yield* withLibraryDatabase(path, databaseIsCurrent(path), true);
    if (ready) return true;
  }
  yield* withLibraryStateReplacement(
    root,
    Effect.gen(function* () {
      if (yield* fs.exists(path)) {
        const current = yield* withLibraryDatabase(path, databaseIsCurrent(path), true);
        if (!current) yield* withLibraryDatabase(path, migrateLibraryDatabase(path));
        return;
      }
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: root,
            prefix: "library-create-",
          });
          const temporary = join(directory, "library.sqlite");
          yield* withLibraryDatabase(
            temporary,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* migrateLibraryDatabase(temporary);
              const checked = yield* sql<{ integrity_check: string }>`PRAGMA integrity_check`;
              if (checked.length !== 1 || checked[0]?.integrity_check !== "ok")
                return yield* new InvalidLibraryState({
                  path: temporary,
                  reason: {
                    _tag: "DatabaseIntegrityInvalid",
                    databasePath: temporary,
                    result: checked.map((row) => row.integrity_check),
                  },
                });
              yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
            }),
          );
          yield* syncPaths([temporary, directory]);
          yield* fs.link(temporary, path);
          yield* syncPaths([path, root]);
        }),
      );
    }),
  );
  return true;
});

/** Join a transaction from either owner; otherwise serialize one new write on this home. */
export const withDatabaseTransaction = <A, E, R>(
  home: string,
  program: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const path = libraryDatabasePath(home);
    const current = yield* currentLibraryTransaction(home);
    if (current?.mode === "locked-write")
      return yield* current.sql.withTransaction(
        program.pipe(Effect.provideService(SqlClient.SqlClient, current.sql)),
      );
    if (current?.mode === "write")
      return yield* new InvalidLibraryState({
        path,
        reason: {
          _tag: "InvalidData",
          issue: "Existing write transaction does not hold the home writer lock",
        },
      });
    yield* prepareLibraryDatabase(home, true);
    return yield* withLibraryStateReplacement(
      home,
      withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.withTransaction(
            program.pipe(
              Effect.provideService(LibraryDatabase, { path, sql, mode: "locked-write" }),
            ),
          );
        }),
      ),
    );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new LibrarySqlError({ path: libraryDatabasePath(home), cause })),
    ),
  );
