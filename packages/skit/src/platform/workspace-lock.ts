import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";

/** Another process, or another hold in this one, has the lock. */
export class WorkspaceLockBusy extends Schema.TaggedError<WorkspaceLockBusy>()(
  "WorkspaceLockBusy",
  { path: Schema.String },
) {}

/** The lock could not be taken for any other reason: I/O, or a file that is not a SQLite database. */
export class WorkspaceLockFailed extends Schema.TaggedError<WorkspaceLockFailed>()(
  "WorkspaceLockFailed",
  { path: Schema.String, cause: Schema.Defect() },
) {}

// node:sqlite reports a held lock as SQLITE_BUSY, error code 5.
const isBusy = Schema.is(Schema.Struct({ errcode: Schema.Literal(5) }));

/**
 * Hold an exclusive lock on `path` until the scope closes. Never waits: a held lock fails
 * WorkspaceLockBusy at once. SQLite because neither Node nor Effect has an OS file-lock API, and
 * an exclusive SQLite transaction takes one (decisions.md A8). The file never holds data and is
 * never unlinked, so the OS releases the lock when the process exits, even on SIGKILL (t3code
 * apps/server/src/serverOwnership.ts:177-219). The caller creates the parent directory and checks
 * the path; this only takes the lock.
 */
export const acquireWorkspaceLock = Effect.fn("WorkspaceLock.acquire")(function* (path: string) {
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(path),
      catch: (cause) => new WorkspaceLockFailed({ path, cause }),
    }).pipe(
      Effect.flatMap((database) =>
        Effect.try({
          try: () => database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"),
          catch: (cause) =>
            isBusy(cause)
              ? new WorkspaceLockBusy({ path })
              : new WorkspaceLockFailed({ path, cause }),
        }).pipe(
          Effect.as(database),
          Effect.tapError(() => Effect.sync(() => database.close())),
        ),
      ),
    ),
    (database) => Effect.sync(() => database.close()),
  );
});
