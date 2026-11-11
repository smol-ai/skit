import {
  AuthorHistoryInvalid,
  AuthorHistoryBusy,
  AuthorSyncStateConflict,
  AuthorBackupStateConflict,
} from "./history-failures.js";
export { AuthorHistoryInvalid } from "./history-failures.js";
/**
 * AuthorHistory: the owner of this device's author history (ADR-0027).
 *
 * It owns <home>/history/{trees,revisions}/**, <home>/history/journal.sqlite* and
 * <home>/author-sync.json. Callers save a workspace's files with `refresh` and `saveTree`, run the
 * sync engine against `engineStore`, and step the sync checkpoint only through `syncState`.
 */
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Result,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { AuthorIgnoreRepository } from "../artifact/plain-author-ignore.js";
import { Hash, sha256Hash } from "../shared/hash.js";
import * as History from "../history/history.js";
import { type HomeBusy } from "../platform/lock-failures.js";
import { LinkStat } from "../platform/link-stat.js";
import * as MachineSettings from "../library/machine-settings.js";
import { SourceProcess } from "../platform/source-process.js";
import * as Sync from "../sync/sync.js";
import { type TreeError } from "../shared/tree-error.js";

import { syncPaths } from "../platform/atomic-write.js";
import { scanAuthorWorkspace } from "./scan.js";
import * as HomeLock from "../platform/home-lock.js";
import { AuthorWorkspaceAlreadyRegistered, LocalFilesChangedDuringSync } from "./failures.js";

import {
  AuthorSyncStateInvalid,
  AuthorWorkspace,
  AuthorWorkspaceConflict,
  type WorkspaceReadError,
  SyncKey,
  WorkspaceId,
  type CreateReceipt,
  type WorkspaceLease,
  type WorkspaceRoot,
} from "./workspace.js";
import { makeHistoryStore, storedPath } from "./history-store.js";
import {
  AuthorRemovalState,
  makeRemovalCheck,
  scanAuthorInventory,
  type RemovalDecision,
} from "./inventory.js";

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/** What refresh saw: the revision that records the workspace's files now, and their tree hash. */
export interface SavedRevision {
  readonly id: History.RevisionId;
  readonly revision: History.Revision;
  readonly treeHash: History.TreeHash;
}

/**
 * Proof that a durable Writing checkpoint names exactly these trees, saved under this lease hold
 * at this revision (A13). Kept private inside the operation returned by syncState.prepareWrite.
 */
const WriteCheckpoint = Schema.Struct({
  key: SyncKey,
  from: History.TreeHash,
  to: History.TreeHash,
  ownerId: Schema.String,
  revision: Schema.Finite,
}).pipe(Schema.brand("WriteCheckpoint"));
export type WriteCheckpoint = typeof WriteCheckpoint.Type;

/** A write bound to its saved trees and lease. Callers cannot replace either. */
interface PreparedWrite {
  readonly apply: () => Effect.Effect<
    (typeof Sync.Writing.Type)["next"],
    | Effect.Error<ReturnType<WorkspaceLease["writeTree"]>>
    | AuthorSyncStateConflict
    | HomeBusy
    | SyncStateError
  >;
}

/** <home>/author-sync.json: one checkpoint per workspace and SKIT locator (A5). */
const AuthorSyncState = Schema.Struct({
  schema: Schema.Literal("skit.author-sync.v1"),
  workspaces: Schema.Record(WorkspaceId, Schema.Record(Schema.String, Sync.SyncState)),
  inventories: Schema.optionalKey(Schema.Record(WorkspaceId, AuthorRemovalState)),
  // A workspace has no backup checkpoint until an observation is acknowledged.
  backups: Schema.optional(
    Schema.Record(WorkspaceId, Schema.Record(Schema.String, History.RevisionId)),
  ),
});
type AuthorSyncState = typeof AuthorSyncState.Type;
const AuthorSyncStateDocument = Schema.fromJsonString(AuthorSyncState);

/** One entry in a workspace's history on this device: the revision its files were saved as. */
const HistoryEvent = Schema.Struct({
  schema: Schema.Literal("skit.author-history-event.v1"),
  workspace_key: Hash,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  revision: History.RevisionId,
  root: Schema.String,
  workspace_id: Schema.optionalKey(Schema.String),
});
type HistoryEvent = typeof HistoryEvent.Type;

export type RefreshError =
  | AuthorHistoryInvalid
  | AuthorHistoryBusy
  | LocalFilesChangedDuringSync
  | AuthorWorkspaceAlreadyRegistered
  | MachineSettings.Unusable
  | HomeBusy // MachineSettings.ensureIdentity takes the home lock (withHomeLock today)
  | TreeError
  | PlatformError.PlatformError;

type SyncStateError = AuthorSyncStateInvalid | PlatformError.PlatformError;

const loadAuthorSyncState = Effect.fn("AuthorHistory.loadSyncState")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const syncStatePath = path.join(home, "author-sync.json");
  const text = yield* fs.readFileString(syncStatePath).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );
  if (Option.isNone(text))
    return { schema: "skit.author-sync.v1", workspaces: {} } satisfies AuthorSyncState;
  return yield* Schema.decodeEffect(AuthorSyncStateDocument)(text.value).pipe(
    Effect.mapError(
      (error) =>
        new AuthorSyncStateInvalid({
          path: syncStatePath,
          reason: { _tag: "InvalidData", failure: error },
        }),
    ),
  );
});

// ── Journal ────────────────────────────────────────────────────────────────────────────────────

const EventDocument = Schema.fromJsonString(HistoryEvent);
/** One stored event row: the event as JSON. */
const EventRow = Schema.Struct({ event_json: EventDocument });
/** v0 is an uninitialized journal; v1 is current. Newer versions require a migration. */
const JournalVersion = Schema.Struct({ user_version: Schema.Literals([0, 1]) });
const JournalWorkspace = Schema.Struct({
  workspace_key: Hash,
  workspace_id: Schema.NullOr(Schema.String),
  root: Schema.String,
});

/**
 * The journal's key for this workspace, or none when the journal does not know it yet. Keeps an
 * anonymous folder's sequence when it later gains an Author Workspace identity.
 */
const resolveJournalWorkspace = Effect.fn("AuthorHistory.resolveJournalWorkspace")(function* (
  root: string,
  workspaceId: string | undefined,
  path: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (workspaceId !== undefined) {
    const rows =
      yield* sql`SELECT workspace_key, workspace_id, root FROM author_history_workspaces WHERE workspace_id = ${workspaceId}`;
    if (rows.length > 0) {
      const workspace = yield* Schema.decodeUnknownEffect(JournalWorkspace)(rows[0]);
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
  const roots = yield* Schema.decodeUnknownEffect(Schema.Array(JournalWorkspace))(
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
const addJournalWorkspace = Effect.fn("AuthorHistory.addJournalWorkspace")(function* (
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
const journalVersion = Effect.fn("AuthorHistory.journalVersion")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Schema.decodeUnknownEffect(JournalVersion)(
    (yield* sql`PRAGMA user_version`)[0],
  ).pipe(
    Effect.mapError(
      (failure) =>
        new AuthorHistoryInvalid({ path, reason: { _tag: "JournalVersionInvalid", failure } }),
    ),
  );
});

const ensureJournalSchema = Effect.fn("AuthorHistory.ensureJournalSchema")(function* (
  path: string,
) {
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
 * `save` runs inside the journal transaction and receives the workspace's latest revision, so an
 * unchanged scan cannot overtake an older one. An event is appended only when `save` returns a
 * different revision. `writers` is the layer's permit (A9).
 */
const writeHistoryEvent = Effect.fn("AuthorHistory.writeHistoryEvent")(function* <
  A extends { readonly id: History.RevisionId },
  E,
  R,
>(
  writers: Semaphore.Semaphore,
  path: string,
  root: string,
  workspaceId: string | undefined,
  save: (latest: History.RevisionId | undefined) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  // Library frontends can load Author's API without opening its Node-only journal driver.
  // Only a history write needs this adapter.
  const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-node"));
  return yield* writers
    .withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* fs.chmod(path, 0o600);
          yield* sql`PRAGMA synchronous = FULL`;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* ensureJournalSchema(path);
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
                (yield* resolveJournalWorkspace(root, workspaceId, path)) ??
                (yield* addJournalWorkspace(root, workspaceId));
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
                  reason: {
                    _tag: "JournalWorkspaceMismatch",
                    expected: key,
                    actual: last.workspace_key,
                  },
                });
              const saved = yield* save(last?.revision);
              if (last?.revision === saved.id) return saved;
              const event: HistoryEvent = {
                schema: "skit.author-history-event.v1",
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
        Effect.fail(
          new AuthorHistoryInvalid({
            path,
            reason: Schema.isSchemaError(error)
              ? { _tag: "JournalSchemaInvalid", failure: error }
              : { _tag: "JournalFailure", cause: error },
          }),
        ),
      ),
    );
});

// ── Surface ────────────────────────────────────────────────────────────────────────────────────

export interface AuthorHistoryShape {
  readonly inventory: {
    readonly refresh: (
      lease: WorkspaceLease,
      workspaceId: WorkspaceId,
      tree: History.Tree,
      allowLargeDeletion?: boolean,
      knownTrees?: readonly History.Tree[],
    ) => Effect.Effect<RemovalDecision, SyncStateError | HomeBusy>;
    readonly reset: (root: string) => Effect.Effect<void>;
  };
  /**
   * Scan the workspace verbatim until stable, store its tree, and record a revision when the tree
   * changed, with a journal event in one SQLite transaction. An unchanged scan returns the latest
   * revision and records nothing. Needs no lease: it writes only home state.
   */
  readonly refresh: (root: WorkspaceRoot) => Effect.Effect<SavedRevision, RefreshError>;
  /** Store a tree (immutable, content-addressed, idempotent). */
  readonly saveTree: (tree: History.Tree) => Effect.Effect<History.TreeHash, AuthorHistoryInvalid>;
  /**
   * The History.Store the sync engine runs against, over <home>/history: a plain value the sync
   * workflow passes to the engine. Its only writes are immutable, content-addressed and
   * idempotent; it never touches the journal or author-sync state.
   */
  readonly engineStore: History.Store;
  /** Acknowledged raw observations, independent of the remote's current content. */
  readonly backupState: {
    /** Absent means nothing has been acknowledged. Never creates files. */
    readonly read: (key: SyncKey) => Effect.Effect<History.RevisionId | null, SyncStateError>;
    /** Advance one revision only after the remote accepts it; preserve every other checkpoint. */
    readonly save: (
      lease: WorkspaceLease,
      key: SyncKey,
      change: { readonly from: History.RevisionId | null; readonly to: History.RevisionId },
    ) => Effect.Effect<
      void,
      AuthorBackupStateConflict | AuthorHistoryInvalid | HomeBusy | SyncStateError
    >;
  };
  /** The sync checkpoint, Idle | Sending | Writing. */
  readonly syncState: {
    /** Absent reads as Idle { base: null }. Never writes. */
    readonly read: (key: SyncKey) => Effect.Effect<Sync.SyncState, SyncStateError>;
    /**
     * Normal Idle/Sending steps, under the home lock for the whole read-modify-write, then
     * lease.advance. Prepared operations own completion from Writing. Only the first connection's
     * `reset` can return to Idle { base: null }.
     */
    readonly save: (
      lease: WorkspaceLease,
      key: SyncKey,
      change:
        | {
            readonly from: typeof Sync.Idle.Type | typeof Sync.Sending.Type;
            readonly to: (typeof Sync.Writing.Type)["next"];
          }
        | { readonly from: Sync.SyncState; readonly reset: CreateReceipt },
    ) => Effect.Effect<
      void,
      | AuthorSyncStateConflict
      | HomeBusy // the shared home lock excludes other home writers
      | SyncStateError
    >;
    /** The step into Writing, once both trees are stored; returns the PreparedWrite for it. */
    readonly prepareWrite: (
      lease: WorkspaceLease,
      key: SyncKey,
      change: Sync.WriteRequest,
    ) => Effect.Effect<
      PreparedWrite,
      | AuthorSyncStateConflict
      | AuthorHistoryInvalid
      | AuthorWorkspaceConflict
      | WorkspaceReadError
      | HomeBusy // the shared home lock excludes other home writers
      | SyncStateError
    >;
  };
}

export interface AuthorHistoryConfig {
  readonly home: string;
}

/** What AuthorHistory.layer requires (the history owner captures these dependencies). */
type Requires =
  | FileSystem.FileSystem
  | Path.Path
  | LinkStat
  | SourceProcess
  | AuthorIgnoreRepository
  | Digest.Digest
  | SecureRandom.SecureRandom
  | AuthorWorkspace;

const make = Effect.fn("AuthorHistory.make")(function* (config: AuthorHistoryConfig) {
  // Only the services: the whole context would carry the layer's own Scope into every call.
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    LinkStat,
    SourceProcess,
    AuthorIgnoreRepository,
    Digest.Digest,
    SecureRandom.SecureRandom,
    AuthorWorkspace,
  )(yield* Effect.context<Requires>());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* LinkStat;
  const workspaces = yield* AuthorWorkspace;
  const home = path.resolve(config.home);
  const directory = path.join(home, "history");
  const journalPath = path.join(directory, "journal.sqlite");
  const syncStatePath = path.join(home, "author-sync.json");
  const engineStore = yield* makeHistoryStore(directory);
  // node:sqlite busy waits block the JS thread. Serialize this home's writers in this process so a
  // second connection cannot block the thread while the first awaits filesystem work. SQLite's
  // BEGIN IMMEDIATE coordinates other processes without a persistent journal lock file (A9).
  const writers = yield* Semaphore.make(1);
  const sameState = Schema.toEquivalence(Sync.SyncState);
  const removalCheck = makeRemovalCheck();
  const inventoryRoots = new Map<string, WorkspaceId>();

  // Stored history that cannot be read back is unusable history, whatever the store's reason.
  const storeFailure = (error: History.StoreError) =>
    Effect.fail(
      new AuthorHistoryInvalid({
        path:
          error._tag === "History.StoreFailed"
            ? directory
            : storedPath(path, directory, error.kind, error.hash),
        reason: { _tag: "StoreFailure", failure: error },
      }),
    );

  /**
   * Save a stable, unvalidated tree before sync can change it. Originals, executable modes,
   * directories and symlinks use the verbatim tree format. Root Git/control exclusions and
   * .gitignore remain in effect. Returning to older content records a new revision that shares
   * the older tree.
   */
  const refresh = Effect.fn("AuthorHistory.refresh")(function* (root: WorkspaceRoot) {
    const insideRoot = (candidatePath: string) =>
      candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`);
    if (insideRoot(home))
      return yield* new AuthorHistoryInvalid({
        path: directory,
        reason: { _tag: "HistoryInsideWorkspace", workspace: root, resolved: false },
      });
    for (const folder of [
      home,
      directory,
      path.join(directory, "trees"),
      path.join(directory, "revisions"),
    ]) {
      yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
      if (insideRoot(yield* fs.realPath(folder)))
        return yield* new AuthorHistoryInvalid({
          path: directory,
          reason: { _tag: "HistoryInsideWorkspace", workspace: root, resolved: true },
        });
    }
    const journalFile = yield* links
      .lstat(journalPath)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    if (journalFile?.type === "SymbolicLink")
      return yield* new AuthorHistoryInvalid({
        path: journalPath,
        reason: { _tag: "JournalRedirected" },
      });
    // Broken device-local metadata must not prevent backing up the authored files. This is
    // path-provenance fallback only; it neither creates nor repairs a workspace identity.
    const workspaceId = yield* workspaces.readIdentity(root).pipe(
      Effect.map((identity) =>
        Option.getOrUndefined(Option.map(identity, (value) => value.workspaceId)),
      ),
      Effect.catchTag("AuthorWorkspaceMetadataInvalid", () => Effect.undefined),
    );
    // Machine identity may need the Library writer. Resolve it before taking the journal
    // permit/transaction, so history never takes the home writer from inside a journal write.
    const identity = yield* Effect.result(
      Effect.gen(function* () {
        const settings = yield* MachineSettings.read(home);
        return settings.machineId ?? (yield* MachineSettings.ensureIdentity(home));
      }),
    );

    const save = (latest: History.RevisionId | undefined) =>
      Effect.gen(function* () {
        const { tree, treeHash } = yield* scanAuthorWorkspace(root);
        const previous =
          latest === undefined
            ? undefined
            : { id: latest, revision: yield* engineStore.revision(latest) };
        const unchanged = previous?.revision.tree === treeHash;
        if (unchanged || Result.isFailure(identity)) {
          // Verify the stored tree, and keep the bytes even when there is no device to record as.
          yield* engineStore.putTree(tree);
          if (previous && unchanged) return { ...previous, treeHash };
        }
        const recorded = yield* History.record(engineStore, tree, previous ? [previous.id] : [], {
          device: yield* Effect.fromResult(identity),
          at: yield* Clock.currentTimeMillis,
        });
        return { ...recorded, treeHash };
      }).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));

    const saved = yield* writeHistoryEvent(writers, journalPath, root, workspaceId, save);
    // The SQL client has closed/checkpointed before acknowledgement; persist new directory entries.
    yield* syncPaths([directory, home, path.dirname(home)]);
    return { id: saved.id, revision: saved.revision, treeHash: saved.treeHash };
  });

  const loadSyncState = loadAuthorSyncState(home);
  const entry = (document: AuthorSyncState, key: SyncKey) =>
    document.workspaces[key.workspaceId]?.[key.locator] ?? Sync.Idle.make({ base: null });

  const read = Effect.fn("AuthorHistory.syncState.read")(function* (key: SyncKey) {
    return entry(yield* loadSyncState, key);
  });

  const saveSyncState = Effect.fn("AuthorHistory.saveSyncState")(function* (next: AuthorSyncState) {
    yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: home,
          prefix: ".sync-state-",
        });
        const temporary = path.join(staging, "state.json");
        const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
        // The document are built from decoded states, so failing to encode them is a defect.
        const text = yield* Schema.encodeEffect(Schema.fromJsonString(AuthorSyncState))(next).pipe(
          Effect.orDie,
        );
        yield* file.writeAll(new TextEncoder().encode(text));
        yield* file.sync;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* fs.rename(temporary, syncStatePath);
            const folder = yield* fs.open(home, { flag: "r" });
            yield* folder.sync;
          }),
        );
      }),
    );
  });

  /**
   * One checkpoint step under the home lock: refuse unless the saved entry still equals `from`,
   * rewrite only that entry (flushed, then renamed over the old file), then advance the lease.
   */
  const step = Effect.fn("AuthorHistory.syncState.step")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    from: Sync.SyncState,
    to: Sync.SyncState,
    resetBackup = false,
  ) {
    return yield* HomeLock.withLock(
      home,
      Effect.gen(function* () {
        // Refuse before writing when the lease is no longer held.
        yield* lease.revision;
        const document = yield* loadSyncState;
        const found = entry(document, key);
        if (!sameState(found, from)) return yield* new AuthorSyncStateConflict({ key, found });
        const backups = { ...document.backups };
        if (resetBackup && backups[key.workspaceId]) {
          const remaining = { ...backups[key.workspaceId] };
          delete remaining[key.locator];
          backups[key.workspaceId] = remaining;
        }
        const next: AuthorSyncState = {
          ...document,
          ...(document.backups === undefined ? {} : { backups }),
          schema: "skit.author-sync.v1",
          workspaces: {
            ...document.workspaces,
            [key.workspaceId]: { ...document.workspaces[key.workspaceId], [key.locator]: to },
          },
        };
        yield* saveSyncState(next);
        return yield* lease.advance;
      }),
    );
  });

  const backupEntry = (document: AuthorSyncState, key: SyncKey) =>
    document.backups?.[key.workspaceId]?.[key.locator] ?? null;
  const readBackup = Effect.fn("AuthorHistory.backupState.read")(function* (key: SyncKey) {
    return backupEntry(yield* loadSyncState, key);
  });
  const saveBackup = Effect.fn("AuthorHistory.backupState.save")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    change: { readonly from: History.RevisionId | null; readonly to: History.RevisionId },
  ) {
    yield* HomeLock.withLock(
      home,
      Effect.gen(function* () {
        yield* lease.revision;
        const document = yield* loadSyncState;
        const found = backupEntry(document, key);
        if (found !== change.from) return yield* new AuthorBackupStateConflict({ key, found });
        if (change.to === found) return;
        const revision = yield* engineStore
          .revision(change.to)
          .pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
        yield* engineStore
          .tree(revision.tree)
          .pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
        const parents = change.from === null ? [] : [change.from];
        if (
          revision.parents.length !== parents.length ||
          revision.parents.some((id, index) => id !== parents[index])
        )
          return yield* new AuthorHistoryInvalid({
            path: syncStatePath,
            reason: {
              _tag: "BackupParentMismatch",
              expected: change.from,
              actual: revision.parents,
            },
          });
        yield* saveSyncState({
          ...document,
          backups: {
            ...document.backups,
            [key.workspaceId]: { ...document.backups?.[key.workspaceId], [key.locator]: change.to },
          },
        });
        yield* lease.advance;
      }),
    );
  });

  const save = Effect.fn("AuthorHistory.syncState.save")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    change:
      | {
          readonly from: typeof Sync.Idle.Type | typeof Sync.Sending.Type;
          readonly to: (typeof Sync.Writing.Type)["next"];
        }
      | { readonly from: Sync.SyncState; readonly reset: CreateReceipt },
  ) {
    if ("reset" in change) {
      yield* step(lease, key, change.from, Sync.Idle.make({ base: null }), true);
      return;
    }
    yield* step(lease, key, change.from, change.to);
  });

  const prepareWrite = Effect.fn("AuthorHistory.syncState.prepareWrite")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    request: Sync.WriteRequest,
  ) {
    const change = structuredClone(request);
    const writing =
      "trees" in change
        ? Sync.Writing.make({ ...change.from, ...change.trees, merged: true })
        : change.to;
    const savedKey = { ...key };
    yield* lease.revision;
    const workspace = yield* workspaces.read(lease.root);
    if (!Option.exists(workspace.identity, (identity) => identity.workspaceId === key.workspaceId))
      return yield* new AuthorWorkspaceConflict({ root: lease.root, found: workspace });
    // Load the exact saved trees once. They remain private to the returned operation.
    const trees = yield* Effect.all({
      from: engineStore.tree(writing.from),
      to: engineStore.tree(writing.to),
    }).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
    for (const tree of [trees.from, trees.to]) {
      const issue = History.treePathIssue(tree);
      if (issue)
        return yield* new AuthorHistoryInvalid({
          path: syncStatePath,
          reason: { _tag: "InvalidTree", issue },
        });
    }
    const revision = yield* step(lease, savedKey, change.from, writing);
    const prepared = WriteCheckpoint.make({
      key: savedKey,
      from: writing.from,
      to: writing.to,
      ownerId: lease.ownerId,
      revision,
    });
    return {
      apply: () =>
        Effect.gen(function* () {
          yield* lease.writeTree({ prepared, ...trees });
          yield* step(lease, savedKey, writing, writing.next);
          return structuredClone(writing.next);
        }).pipe(Effect.provide(context)),
    };
  });

  const refreshInventory = Effect.fn("AuthorHistory.inventory.refresh")(function* (
    lease: WorkspaceLease,
    workspaceId: WorkspaceId,
    tree: History.Tree,
    allowLargeDeletion = false,
    knownTrees: readonly History.Tree[] = [],
  ) {
    return yield* HomeLock.withLock(
      home,
      Effect.gen(function* () {
        yield* lease.revision;
        inventoryRoots.set(lease.root, workspaceId);
        const document = yield* loadSyncState;
        const previous = document.inventories?.[workspaceId];
        const observed = yield* scanAuthorInventory(tree, previous?.inventory);
        const known = yield* Effect.forEach(knownTrees, (tree) =>
          scanAuthorInventory(tree, previous?.inventory),
        );
        const { decision, accepted } = yield* removalCheck.check(
          workspaceId,
          previous,
          observed,
          allowLargeDeletion,
          {
            files: [...new Set(known.flatMap((item) => item.inventory.files))],
            members: [...new Set(known.flatMap((item) => item.inventory.members))],
          },
        );
        if (JSON.stringify(previous) !== JSON.stringify(accepted)) {
          yield* saveSyncState({
            ...document,
            inventories: { ...document.inventories, [workspaceId]: accepted },
          });
          yield* lease.advance;
        }
        return decision;
      }),
    );
  });

  const resetRemovalGrace = (root: string) =>
    Effect.gen(function* () {
      const workspaceId = inventoryRoots.get(root);
      if (workspaceId !== undefined) yield* removalCheck.reset(workspaceId);
    });
  const service: AuthorHistoryShape = {
    inventory: {
      refresh: (lease, workspaceId, tree, allowLargeDeletion, knownTrees) =>
        refreshInventory(lease, workspaceId, tree, allowLargeDeletion, knownTrees).pipe(
          Effect.provide(context),
        ),
      reset: resetRemovalGrace,
    },
    refresh: (root) =>
      refresh(root).pipe(
        Effect.onError(() => resetRemovalGrace(root)),
        Effect.provide(context),
      ),
    saveTree: (tree) =>
      engineStore.putTree(tree).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure)),
    engineStore,
    backupState: {
      read: (key) => readBackup(key).pipe(Effect.provide(context)),
      save: (lease, key, change) => saveBackup(lease, key, change).pipe(Effect.provide(context)),
    },
    syncState: {
      read: (key) => read(key).pipe(Effect.provide(context)),
      save: (lease, key, change) => save(lease, key, change).pipe(Effect.provide(context)),
      prepareWrite: (lease, key, change) =>
        prepareWrite(lease, key, change).pipe(Effect.provide(context)),
    },
  };
  return service;
});

export class AuthorHistory extends Context.Service<AuthorHistory, AuthorHistoryShape>()(
  "skit/author/AuthorHistory",
) {
  /** One layer per home, shared by the runtime, so one journal permit guards each home (A9). */
  static readonly layer = (config: AuthorHistoryConfig) =>
    Layer.effect(AuthorHistory, make(config));
}

/** Storage representation errors are reported as unusable Author history at the owner boundary. */
export const authorHistoryStoreError = (error: History.StoreError) =>
  new AuthorHistoryInvalid({
    path: "history",
    reason: { _tag: "StoreFailure", failure: error },
  });

/** A passive check starts no grace and saves no smaller baseline. It describes a fresh manual
 * operation; only a leased refresh may advance accepted inventory or confirm disappearance. */
export const checkAuthorRemovals = Effect.fn("Author.checkRemovals")(function* (
  home: string,
  workspaceId: string,
  tree: History.Tree,
) {
  const state = yield* loadAuthorSyncState(home);
  const previous = state.inventories?.[WorkspaceId.make(workspaceId)];
  return (yield* makeRemovalCheck().check(
    workspaceId,
    previous,
    yield* scanAuthorInventory(tree, previous?.inventory),
  )).decision;
});

export type { AuthorHistoryBusy, AuthorSyncStateConflict, AuthorBackupStateConflict };
