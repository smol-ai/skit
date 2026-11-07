import { createRequire } from "node:module";
import { Effect, Schema } from "effect";

// Bun 1.3 runs the TUI but does not implement node:sqlite. Both runtimes use the same
// SQLite file locks; load only the native driver available in this process.
const sqlite = createRequire(import.meta.url)(process.versions.bun ? "bun:sqlite" : "node:sqlite");
const Database: new (path: string) => {
  exec(sql: string): void;
  close(): void;
} = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;

/** Another process, or another hold in this one, has the lock. */
export class FileLockBusy extends Schema.TaggedError<FileLockBusy>()("FileLockBusy", {
  path: Schema.String,
}) {}

/** The lock could not be taken for any other reason: I/O, or a file that is not a SQLite database. */
export class FileLockFailed extends Schema.TaggedError<FileLockFailed>()("FileLockFailed", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

// Node uses errcode; Bun uses errno. Both report SQLite's SQLITE_BUSY (5).
const isBusy = Schema.is(
  Schema.Union([
    Schema.Struct({ errcode: Schema.Literal(5) }),
    Schema.Struct({ errno: Schema.Literal(5) }),
  ]),
);

/**
 * Hold an exclusive lock on `path` until the scope closes. Never waits: a held lock fails
 * FileLockBusy at once. SQLite because neither Node nor Effect has an OS file-lock API, and
 * an exclusive SQLite transaction takes one (decisions.md A8). The file never holds data and is
 * never unlinked, so the OS releases the lock when the process exits, even on SIGKILL (t3code
 * apps/server/src/serverOwnership.ts:177-219). The caller creates the parent directory and checks
 * the path; this only takes the lock.
 */
export const lockFile = Effect.fn("FileLock.acquire")(function* (path: string) {
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Database(path),
      catch: (cause) => new FileLockFailed({ path, cause }),
    }).pipe(
      Effect.flatMap((database) =>
        Effect.try({
          try: () => database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"),
          catch: (cause) =>
            isBusy(cause) ? new FileLockBusy({ path }) : new FileLockFailed({ path, cause }),
        }).pipe(
          Effect.as(database),
          Effect.tapError(() => Effect.sync(() => database.close())),
        ),
      ),
    ),
    (database) => Effect.sync(() => database.close()),
  );
});
