import { SqliteClient } from "@effect/sql-sqlite-node";
import { Array, Effect, FileSystem, Option, Path, Schema, Semaphore, Schedule } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import {
  AuthorHistoryEvent,
  AuthorHistoryInvalid,
  AuthorHistoryBusy,
} from "./history-contracts.js";
import { AuthorWorkspace } from "../../author/workspace.js";
import { AuthorWorkspaceAlreadyRegistered } from "../../library/failures.js";
import { Hash, sha256Hash, type History } from "@smolai/skit-core";

const EventDocument = Schema.fromJsonString(AuthorHistoryEvent);
/** One stored event row: the event as JSON. */
const EventRow = Schema.Struct({ event_json: EventDocument });
/** v0 is an uninitialized journal; v1 is current. Newer versions require a migration. */
const JournalVersion = Schema.Struct({ user_version: Schema.Literals([0, 1]) });
const Workspace = Schema.Struct({
  workspace_key: Hash,
  workspace_id: Schema.NullOr(Schema.String),
  root: Schema.String,
});

// node:sqlite busy waits block the JS thread. Serialize our own writers so a second
// connection cannot block the thread while the first awaits filesystem work. SQLite's
// BEGIN IMMEDIATE coordinates other processes without a persistent journal lock file.
const writers = Semaphore.makeUnsafe(1);

/**
 * The journal's key for this workspace, or none when the journal does not know it yet. Keeps an
 * anonymous folder's sequence when it later gains an Author Workspace identity.
 */
const resolveWorkspace = Effect.fn("Author.resolveHistoryWorkspace")(function* (
  root: string,
  workspaceId: string | undefined,
  writable: boolean,
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
      }
      if (writable && workspace.root !== root)
        yield* sql`UPDATE author_history_workspaces SET root = ${root} WHERE workspace_key = ${workspace.workspace_key}`;
      return workspace.workspace_key;
    }
  }
  const roots = yield* Schema.decodeUnknownEffect(Schema.Array(Workspace))(
    yield* sql`SELECT workspace_key, workspace_id, root FROM author_history_workspaces WHERE root = ${root}`,
  );
  if (workspaceId === undefined && roots.length > 1)
    return yield* new AuthorHistoryInvalid({
      path,
      reason: "workspace identity is ambiguous at this path",
    });
  const existing = roots.length === 1 ? roots[0] : undefined;
  if (existing && (workspaceId === undefined || existing.workspace_id === null)) {
    if (writable && workspaceId !== undefined)
      yield* sql`UPDATE author_history_workspaces SET workspace_id = ${workspaceId} WHERE workspace_key = ${existing.workspace_key}`;
    return existing.workspace_key;
  }
  return undefined;
});

/** Give a workspace the journal does not know its own key. */
const addWorkspace = Effect.fn("Author.addHistoryWorkspace")(function* (
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

/** The journal's schema version; one this CLI does not know is unusable history. */
const journalVersion = Effect.fn("Author.historyJournalVersion")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Schema.decodeUnknownEffect(JournalVersion)(
    (yield* sql`PRAGMA user_version`)[0],
  ).pipe(
    Effect.mapError(() => new AuthorHistoryInvalid({ path, reason: "unsupported journal schema" })),
  );
});

const ensureSchema = Effect.fn("Author.ensureHistorySchema")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* journalVersion(path)).user_version === 1) return;
  yield* sql`CREATE TABLE IF NOT EXISTS author_history_workspaces (
    workspace_key TEXT PRIMARY KEY,
    workspace_id TEXT UNIQUE,
    root TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS author_history_workspace_roots ON author_history_workspaces(root)`;
  yield* sql`CREATE TABLE IF NOT EXISTS author_history_events (
    workspace_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (workspace_key, sequence)
  ) WITHOUT ROWID`;
  yield* sql`PRAGMA user_version = 1`;
});

/**
 * `save` runs inside the transaction and receives the workspace's latest revision, so an
 * unchanged scan cannot overtake an older one. An event is appended only when `save` returns a
 * different revision.
 */
export const writeAuthorHistoryEvent = Effect.fn("Author.writeHistoryEvent")(function* <
  A extends { readonly id: History.RevisionId },
  E,
  R,
>(
  directory: string,
  root: string,
  workspaceId: string | undefined,
  save: (latest: History.RevisionId | undefined) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = (yield* Path.Path).join(directory, "journal.sqlite");

  return yield* writers
    .withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* fs.chmod(path, 0o600);
          yield* sql`PRAGMA synchronous = FULL`;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* ensureSchema(path);
              // BEGIN IMMEDIATE creates WAL/SHM, including on a fresh journal.
              yield* Effect.forEach(
                [`${path}-wal`, `${path}-shm`],
                (sidecar) =>
                  fs
                    .chmod(sidecar, 0o600)
                    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
                { discard: true },
              );

              const key =
                (yield* resolveWorkspace(root, workspaceId, true, path)) ??
                (yield* addWorkspace(root, workspaceId));
              const last = Option.getOrUndefined(
                Option.map(
                  yield* SqlSchema.findOneOption({
                    Request: Hash,
                    Result: EventRow,
                    execute: (workspace) => sql`SELECT event_json FROM author_history_events
                      WHERE workspace_key = ${workspace} ORDER BY sequence DESC LIMIT 1`,
                  })(key),
                  (row) => row.event_json,
                ),
              );
              if (last && last.workspace_key !== key)
                return yield* new AuthorHistoryInvalid({
                  path,
                  reason: "journal workspace does not match",
                });
              const saved = yield* save(last?.revision);
              if (last?.revision === saved.id) return saved;
              const event: AuthorHistoryEvent = {
                schema: "skit.author-history-event.v2",
                workspace_key: key,
                sequence: (last?.sequence ?? 0) + 1,
                revision: saved.id,
                root,
                ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
              };
              const encoded = yield* Schema.encodeEffect(EventDocument)(event);
              yield* sql`INSERT INTO author_history_events (workspace_key, sequence, event_json)
        VALUES (${key}, ${event.sequence}, ${encoded})`;
              return saved;
            }),
          );
        }).pipe(Effect.provide(SqliteClient.layer({ filename: path, busyTimeout: 0 }))),
      ),
    )
    .pipe(
      // Each failed scope closes before yielding. Retry only SQLite contention;
      // corrupt schemas, failed scans and interrupted recordings are never retried.
      Effect.retry({
        while: (error) => isSqlError(error) && error.reason._tag === "LockTimeoutError",
        schedule: Schedule.spaced("25 millis"),
        times: 200,
      }),
      Effect.catchIf(
        (error) => isSqlError(error) && error.reason._tag === "LockTimeoutError",
        () => Effect.fail(new AuthorHistoryBusy({ path })),
      ),
      // A journal SQLite or its schema cannot read is unusable history.
      Effect.catchTag(["SqlError", "SchemaError"], (error) =>
        Effect.fail(new AuthorHistoryInvalid({ path, reason: String(error) })),
      ),
    );
});

/** Metadata-only, per-workspace read; it neither creates a database nor decodes tree contents. */
export const loadAuthorHistoryEvents = Effect.fn("Author.loadHistoryEvents")(function* (
  directory: string,
  root: string,
  workspaceId?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = (yield* Path.Path).join(directory, "journal.sqlite");
  if (!(yield* fs.exists(path))) return Array.empty<AuthorHistoryEvent>();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const version = yield* journalVersion(path);
      const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('author_history_events', 'author_history_workspaces')`;
      if (tables.length === 0) {
        if (version.user_version === 0) return Array.empty<AuthorHistoryEvent>();
        return yield* new AuthorHistoryInvalid({ path, reason: "journal table is missing" });
      }
      if (tables.length !== 2)
        return yield* new AuthorHistoryInvalid({
          path,
          reason: "journal workspace table is missing",
        });
      const key = yield* resolveWorkspace(root, workspaceId, false, path);
      if (key === undefined) return Array.empty<AuthorHistoryEvent>();
      const events = (yield* SqlSchema.findAll({
        Request: Hash,
        Result: EventRow,
        execute: (workspace) => sql`SELECT event_json FROM author_history_events
          WHERE workspace_key = ${workspace} ORDER BY sequence ASC`,
      })(key)).map((row) => row.event_json);
      if (
        !events.every((event, index) => event.workspace_key === key && event.sequence === index + 1)
      )
        return yield* new AuthorHistoryInvalid({
          path,
          reason: "journal sequence is incomplete or malformed",
        });
      return events;
    }).pipe(Effect.provide(SqliteClient.layer({ filename: path, readonly: true, busyTimeout: 0 }))),
  ).pipe(
    Effect.catchTag(["SqlError", "SchemaError"], (error) =>
      Effect.fail(new AuthorHistoryInvalid({ path, reason: String(error) })),
    ),
  );
});
