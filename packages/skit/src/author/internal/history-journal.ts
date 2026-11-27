import { Effect, FileSystem, Option, Schema, Semaphore, Schedule } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { join } from "node:path";
import * as History from "../../history/history.js";
import { Hash, sha256Hash } from "../../shared/hash.js";
import { canonicalJson } from "../../shared/json.js";
import { HomeBusy } from "../../platform/lock-failures.js";
import { lockFile } from "../../platform/file-lock.js";
import { LinkStat } from "../../platform/link-stat.js";
import { AuthorHistoryBusy, AuthorHistoryInvalid } from "../history-failures.js";
import { AuthorWorkspaceAlreadyRegistered } from "../failures.js";
import { AuthorWorkspace, type SyncKey } from "./workspace.js";
import * as AuthorState from "./state-store.js";
import { InvalidLibraryState, LibrarySqlError } from "../../library/failures.js";
import {
  currentLibraryTransaction,
  libraryDatabasePath,
  withDatabaseTransaction,
} from "../../library/database.js";

const HistoryEvent = Schema.Struct({
  schema: Schema.Literal("skit.author-history-event.v1"),
  workspace_key: Hash,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  revision: History.RevisionId,
  root: Schema.String,
  workspace_id: Schema.optionalKey(Schema.String),
});
type HistoryEvent = typeof HistoryEvent.Type;
const Workspace = Schema.Struct({
  workspace_key: Hash,
  workspace_id: Schema.NullOr(Schema.String),
  root: Schema.String,
});
const invalid = (path: string, cause: unknown) =>
  new AuthorHistoryInvalid({ path, reason: { _tag: "JournalFailure", cause } });

const saveEvent = Effect.fn("AuthorHistory.saveEvent")(function* (event: HistoryEvent) {
  const sql = yield* SqlClient.SqlClient;
  yield* Schema.decodeUnknownEffect(HistoryEvent, { onExcessProperty: "error" })(event);
  yield* sql`INSERT INTO author_history_events(workspace_key,sequence,revision,root,workspace_id)
    VALUES(${event.workspace_key},${event.sequence},${event.revision},${event.root},${event.workspace_id ?? null})`;
});

const latestEvent = Effect.fn("AuthorHistory.latestEvent")(function* (key: Hash) {
  const sql = yield* SqlClient.SqlClient;
  const row = (yield* sql<{
    workspace_key: string;
    sequence: number;
    revision: string;
    root: string;
    workspace_id: string | null;
  }>`SELECT * FROM author_history_events WHERE workspace_key=${key} ORDER BY sequence DESC LIMIT 1`)[0];
  if (!row) return undefined;
  return yield* Schema.decodeUnknownEffect(HistoryEvent, { onExcessProperty: "error" })({
    schema: "skit.author-history-event.v1",
    workspace_key: row.workspace_key,
    sequence: row.sequence,
    revision: row.revision,
    root: row.root,
    ...(row.workspace_id === null ? {} : { workspace_id: row.workspace_id }),
  });
});

// The original registration rules stay with the owner of the history timeline.
/**
 * The journal's key for this workspace, or none when the journal does not know it yet. Keeps an
 * anonymous folder's sequence when it later gains an Author Workspace identity.
 */
const resolveWorkspace = Effect.fn("AuthorHistory.resolveWorkspace")(function* (
  root: string,
  workspaceId: string | undefined,
  path: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (workspaceId !== undefined) {
    const rows =
      yield* sql`SELECT workspace_key, workspace_id, root FROM author_history_workspaces WHERE workspace_id = ${workspaceId}`;
    if (rows.length > 0) {
      const workspace = yield* Schema.decodeUnknownEffect(Workspace)(rows[0]);
      if (workspace.root !== root) {
        // Only a live copy elsewhere refuses: a gone root, or one without this identity, does not.
        const workspaces = yield* AuthorWorkspace;
        const previous = yield* workspaces.resolveRoot(workspace.root).pipe(
          Effect.flatMap(workspaces.readIdentity),
          Effect.catchTags({
            AuthorWorkspaceRootInvalid: () => Effect.succeedNone,
            AuthorWorkspaceMetadataInvalid: () => Effect.succeedNone,
          }),
        );
        if (Option.exists(previous, (identity) => identity.workspaceId === workspaceId))
          return yield* new AuthorWorkspaceAlreadyRegistered({ workspaceId, at: workspace.root });
        yield* sql`UPDATE author_history_workspaces SET root = ${root} WHERE workspace_key = ${workspace.workspace_key}`;
      }
      return workspace.workspace_key;
    }
  }
  const roots = yield* Schema.decodeUnknownEffect(Schema.Array(Workspace))(
    yield* sql`SELECT workspace_key, workspace_id, root FROM author_history_workspaces WHERE root = ${root}`,
  );
  if (workspaceId === undefined && roots.length > 1)
    return yield* new AuthorHistoryInvalid({
      path,
      reason: { _tag: "AmbiguousWorkspace" },
    });
  const existing = roots.length === 1 ? roots[0] : undefined;
  if (existing && (workspaceId === undefined || existing.workspace_id === null)) {
    if (workspaceId !== undefined)
      yield* sql`UPDATE author_history_workspaces SET workspace_id = ${workspaceId} WHERE workspace_key = ${existing.workspace_key}`;
    return existing.workspace_key;
  }
  return undefined;
});

/** Give a workspace the journal does not know its own key. */
const addWorkspace = Effect.fn("AuthorHistory.addWorkspace")(function* (
  root: string,
  workspaceId: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  // Keep the existing Hash encoding, but identify an alias with a random nonce rather
  // than a reusable root or workspace ID. Existing keys and event documents stay valid.
  const key = yield* sha256Hash(yield* (yield* SecureRandom.SecureRandom).randomBytes(32));
  yield* sql`INSERT INTO author_history_workspaces (workspace_key, workspace_id, root)
    VALUES (${key}, ${workspaceId ?? null}, ${root})`;
  return key;
});

const retryable = (error: unknown) =>
  Schema.is(HomeBusy)(error) ||
  (Schema.is(History.StoreFailed)(error) && Schema.is(HomeBusy)(error.cause)) ||
  Schema.is(Schema.Struct({ _tag: Schema.Literal("FileLockBusy") }))(error) ||
  (isSqlError(error) && error.reason._tag === "LockTimeoutError") ||
  (Schema.is(LibrarySqlError)(error) &&
    isSqlError(error.cause) &&
    error.cause.reason._tag === "LockTimeoutError");

/** Serialize scans with an OS lock; the shared database never holds a writer through file work. */
const withHistoryWriter = Effect.fn("AuthorHistory.withHistoryWriter")(function* <A, E, R>(
  writers: Semaphore.Semaphore,
  home: string,
  program: Effect.Effect<A, E | Schema.SchemaError | LibrarySqlError | InvalidLibraryState, R>,
) {
  const path = libraryDatabasePath(home);
  const directory = join(home, "history");
  const lockPath = join(directory, "lock.sqlite");
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  if (yield* currentLibraryTransaction(home))
    return yield* invalid(path, { _tag: "HistoryScanInsideDatabaseTransaction" });
  return yield* writers
    .withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          const lock = yield* links
            .lstat(lockPath)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          if (lock?.type === "SymbolicLink")
            return yield* new AuthorHistoryInvalid({
              path: lockPath,
              reason: { _tag: "JournalRedirected" },
            });
          // Keep existing lock files private, including when another process holds the lock.
          if (lock !== undefined) yield* fs.chmod(lockPath, 0o600);
          yield* lockFile(lockPath);
          yield* fs.chmod(lockPath, 0o600);
          return yield* program;
        }),
      ),
    )
    .pipe(
      Effect.retry({ while: retryable, schedule: Schedule.spaced("25 millis"), times: 200 }),
      Effect.catchIf(retryable, () => Effect.fail(new AuthorHistoryBusy({ path: lockPath }))),
      Effect.catchTag("FileLockBusy", () => Effect.fail(new AuthorHistoryBusy({ path: lockPath }))),
      Effect.catchTag(
        ["LibrarySqlError", "InvalidLibraryState", "FileLockFailed", "SchemaError"],
        (error) =>
          Effect.fail(
            Schema.isSchemaError(error)
              ? new AuthorHistoryInvalid({
                  path,
                  reason: { _tag: "JournalSchemaInvalid", failure: error },
                })
              : invalid(path, error),
          ),
      ),
    );
});

/** Tree work stays outside SQL, while both processes and this owner serialize journal writes. */
export const writeHistoryEvent = <A extends { readonly id: History.RevisionId }, E, R>(
  writers: Semaphore.Semaphore,
  home: string,
  root: string,
  workspaceId: string | undefined,
  save: (latest: History.RevisionId | undefined) => Effect.Effect<A, E, R>,
) =>
  withHistoryWriter(
    writers,
    home,
    Effect.gen(function* () {
      const path = libraryDatabasePath(home);
      const { key, last } = yield* withDatabaseTransaction(
        home,
        Effect.gen(function* () {
          const key =
            (yield* resolveWorkspace(root, workspaceId, path)) ??
            (yield* addWorkspace(root, workspaceId));
          return { key, last: yield* latestEvent(key) };
        }),
      );
      // Tree scanning, immutable byte writes, fsync and revision creation are outside SQL transactions.
      const saved = yield* save(last?.revision);
      if (last?.revision === saved.id) return saved;
      yield* withDatabaseTransaction(
        home,
        Effect.gen(function* () {
          const current = yield* latestEvent(key);
          if (canonicalJson(current) !== canonicalJson(last))
            return yield* invalid(path, { _tag: "JournalHeadChanged" });
          yield* saveEvent({
            schema: "skit.author-history-event.v1",
            workspace_key: key,
            sequence: (last?.sequence ?? 0) + 1,
            revision: saved.id,
            root,
            ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
          });
        }),
      );
      return saved;
    }),
  );

/**
 * Best-effort pure-pull completion. The head and ACK move together; their guards and the lease
 * are checked again in the committing transaction. A crash before this step may still cause one redundant
 * backup, through the ordinary refresh path. No recovery or authored input is discarded.
 */
export const saveReceivedHistory = <E, R>(
  writers: Semaphore.Semaphore,
  home: string,
  root: string,
  key: SyncKey,
  change: { readonly before: History.RevisionId; readonly received: History.RevisionId },
  checkTree: Effect.Effect<boolean, E, R>,
  checkLease: Effect.Effect<boolean>,
) =>
  withHistoryWriter(
    writers,
    home,
    Effect.gen(function* () {
      const check = Effect.gen(function* () {
        const workspace = yield* resolveWorkspace(root, key.workspaceId, libraryDatabasePath(home));
        if (workspace === undefined) return undefined;
        const last = yield* latestEvent(workspace);
        if (last?.revision !== change.before) return undefined;
        const state = yield* AuthorState.readAuthorSyncState(home, key);
        if (state._tag !== "Idle" || state.base !== change.received) return undefined;
        if ((yield* AuthorState.readAuthorBackup(home, key)) !== change.before) return undefined;
        return { workspace, last };
      });
      if ((yield* withDatabaseTransaction(home, check)) === undefined) return false;
      if (!(yield* checkTree)) return false;
      return yield* withDatabaseTransaction(
        home,
        Effect.gen(function* () {
          const found = yield* check;
          if (found === undefined || !(yield* checkLease)) return false;
          yield* saveEvent({
            schema: "skit.author-history-event.v1",
            workspace_key: found.workspace,
            sequence: found.last.sequence + 1,
            revision: change.received,
            root,
            workspace_id: key.workspaceId,
          });
          yield* AuthorState.saveAuthorBackup(key, change.received);
          return true;
        }),
      );
    }),
  );
