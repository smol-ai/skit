/**
 * AuthorHistory: the owner of this device's author history (architecture/author.ts).
 *
 * It owns <home>/history/{trees,revisions}/**, <home>/history/journal.sqlite* and
 * <home>/sync-bindings.json. Callers save a workspace's files with `capture` and `retain`, run the
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
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { Hash, sha256Hash } from "../shared/hash.js";
import * as History from "../history/history.js";
import { type HomeBusy } from "../platform/lock-failures.js";
import { LinkStat } from "../platform/link-stat.js";
import * as MachineSettings from "../library/machine-settings.js";
import { SourceProcess } from "../platform/source-process.js";
import * as Sync from "../sync/sync.js";
import { type TreeError } from "../shared/tree-error.js";

import { syncPaths } from "../platform/atomic-write.js";
import { walkAuthorTree } from "../artifact/tree.js";
import * as HomeLock from "../platform/home-lock.js";
import { AuthorWorkspaceAlreadyRegistered, LocalFilesChangedDuringSync } from "./failures.js";

import {
  AuthorSyncStateInvalid,
  AuthorWorkspace,
  SyncKey,
  WorkspaceId,
  type AuthorLeaseNotHeld,
  type CreateReceipt,
  type WorkspaceLease,
  type WorkspaceRoot,
} from "./workspace.js";
import { makeHistoryStore, storedPath } from "./history-store.js";

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────

export class AuthorHistoryInvalid
  extends Schema.TaggedError<AuthorHistoryInvalid>()("AuthorHistoryInvalid", {
    path: Schema.String,
    reason: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `Author history at ${this.path} is unusable: ${this.reason}`;
  }
  readonly remediation =
    "Keep the history files and resolve the storage problem before syncing again.";
}

/** Contention is temporary; it says nothing about the validity of stored history. */
export class AuthorHistoryBusy
  extends Schema.TaggedError<AuthorHistoryBusy>()("AuthorHistoryBusy", { path: Schema.String })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
  get message() {
    return `Author history at ${this.path} is busy with another recording`;
  }
  readonly remediation = "Retry after the other recording completes.";
}

/** The saved checkpoint is no longer the one the step planned from. */
export class AuthorSyncStateConflict
  extends Schema.TaggedError<AuthorSyncStateConflict>()("AuthorSyncStateConflict", {
    key: SyncKey,
    found: Sync.SyncState,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
  get message() {
    return `The sync checkpoint for ${this.key.locator} changed while this sync was running`;
  }
  readonly remediation = "Sync again; it plans from the checkpoint saved now.";
}

/** `from → to` is not a step the sync engine takes (Sync.allowsStep). */
export class AuthorSyncStateIllegal
  extends Schema.TaggedError<AuthorSyncStateIllegal>()("AuthorSyncStateIllegal", {
    key: SyncKey,
    from: Sync.SyncState,
    to: Sync.SyncState,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `Sync tried to save ${this.to._tag} after ${this.from._tag} for ${this.key.locator}, a step the sync engine never takes`;
  }
  readonly remediation = "Report this; the saved checkpoint is unchanged.";
}

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/** What capture saw: the revision that records the workspace's files now, and their tree hash. */
export interface Observation {
  readonly id: History.RevisionId;
  readonly revision: History.Revision;
  readonly treeHash: History.TreeHash;
}

/**
 * Proof that a durable Writing checkpoint names exactly these trees, saved under this lease hold
 * at this revision (A13). Minted only by syncState.prepareWrite; WorkspaceLease.writeTree
 * requires one and uses it up.
 */
const PreparedWrite = Schema.Struct({
  key: SyncKey,
  from: History.TreeHash,
  to: History.TreeHash,
  ownerId: Schema.String,
  revision: Schema.Number,
}).pipe(Schema.brand("PreparedWrite"));
export type PreparedWrite = typeof PreparedWrite.Type;

/** <home>/sync-bindings.json: one checkpoint per workspace and SKIT locator (A5). */
const SyncBindings = Schema.Struct({
  schema: Schema.Literal("skit.sync-bindings.v4"),
  workspaces: Schema.Record(WorkspaceId, Schema.Record(Schema.String, Sync.SyncState)),
});
type SyncBindings = typeof SyncBindings.Type;
/** Formats from unreleased builds, keyed by locator only: recognized only to refuse them. */
const UnreleasedBindings = Schema.Struct({
  schema: Schema.Literals(["skit.sync-bindings.v3", "skit.sync-bindings.v2"]),
});
const BindingsDocument = Schema.fromJsonString(Schema.Union([SyncBindings, UnreleasedBindings]));

/** One entry in a workspace's history on this device: the revision its files were saved as. */
const HistoryEvent = Schema.Struct({
  schema: Schema.Literal("skit.author-history-event.v2"),
  workspace_key: Hash,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  revision: History.RevisionId,
  root: Schema.String,
  workspace_id: Schema.optionalKey(Schema.String),
});
type HistoryEvent = typeof HistoryEvent.Type;

export type CaptureError =
  | AuthorHistoryInvalid
  | AuthorHistoryBusy
  | LocalFilesChangedDuringSync
  | AuthorWorkspaceAlreadyRegistered
  | MachineSettings.Unusable
  | HomeBusy // MachineSettings.ensureIdentity takes the home lock (withHomeLock today)
  | TreeError
  | PlatformError.PlatformError;

export type SyncStateError = AuthorSyncStateInvalid | PlatformError.PlatformError;

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
      reason: "workspace identity is ambiguous at this path",
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
    Effect.mapError(() => new AuthorHistoryInvalid({ path, reason: "unsupported journal schema" })),
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
                  reason: "journal workspace does not match",
                });
              const saved = yield* save(last?.revision);
              if (last?.revision === saved.id) return saved;
              const event: HistoryEvent = {
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

// ── Surface ────────────────────────────────────────────────────────────────────────────────────

export interface AuthorHistoryShape {
  /**
   * Scan the workspace verbatim until stable, store its tree, and record a revision when the tree
   * changed, with a journal event in one SQLite transaction. An unchanged scan returns the latest
   * revision and records nothing. Needs no lease: it writes only home state.
   */
  readonly capture: (root: WorkspaceRoot) => Effect.Effect<Observation, CaptureError>;
  /** Store a tree (immutable, content-addressed, idempotent). */
  readonly retain: (tree: History.Tree) => Effect.Effect<History.TreeHash, AuthorHistoryInvalid>;
  /**
   * The History.Store the sync engine runs against, over <home>/history: a plain value the sync
   * workflow passes to the engine. Its only writes are immutable, content-addressed and
   * idempotent; it never touches the journal or sync-bindings.
   */
  readonly engineStore: History.Store;
  /** The sync checkpoint, Idle | Sending | Writing. */
  readonly syncState: {
    /** Absent reads as Idle { base: null }. Never writes. */
    readonly read: (key: SyncKey) => Effect.Effect<Sync.SyncState, SyncStateError>;
    /**
     * Every step except into Writing, under the home lock for the whole read-modify-write, then
     * lease.advance. `reset` is the only way back to Idle { base: null }: the first connection.
     */
    readonly save: (
      lease: WorkspaceLease,
      key: SyncKey,
      change:
        | {
            readonly from: Sync.SyncState;
            readonly to: Exclude<Sync.SyncState, { readonly _tag: "Writing" }>;
          }
        | { readonly from: Sync.SyncState; readonly reset: CreateReceipt },
    ) => Effect.Effect<
      void,
      | AuthorSyncStateConflict
      | AuthorSyncStateIllegal
      | AuthorLeaseNotHeld
      | HomeBusy // the shared home lock excludes other home writers
      | SyncStateError
    >;
    /** The step into Writing, once both trees are stored; returns the PreparedWrite for it. */
    readonly prepareWrite: (
      lease: WorkspaceLease,
      key: SyncKey,
      change: {
        readonly from: Sync.SyncState;
        readonly to: Extract<Sync.SyncState, { readonly _tag: "Writing" }>;
      },
    ) => Effect.Effect<
      PreparedWrite,
      | AuthorSyncStateConflict
      | AuthorSyncStateIllegal
      | AuthorLeaseNotHeld
      | AuthorHistoryInvalid
      | HomeBusy // the shared home lock excludes other home writers
      | SyncStateError
    >;
  };
}

export interface AuthorHistoryConfig {
  readonly home: string;
}

/** What AuthorHistory.layer requires (architecture/author.ts AuthorHistoryRequires). */
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
  const bindingsPath = path.join(home, "sync-bindings.json");
  const engineStore = yield* makeHistoryStore(directory);
  // node:sqlite busy waits block the JS thread. Serialize this home's writers in this process so a
  // second connection cannot block the thread while the first awaits filesystem work. SQLite's
  // BEGIN IMMEDIATE coordinates other processes without a persistent journal lock file (A9).
  const writers = yield* Semaphore.make(1);
  const sameState = Schema.toEquivalence(Sync.SyncState);

  // Stored history that cannot be read back is unusable history, whatever the store's reason.
  const storeFailure = (error: History.StoreError) =>
    Effect.fail(
      error._tag === "History.StoreFailed"
        ? new AuthorHistoryInvalid({ path: directory, reason: String(error.cause) })
        : new AuthorHistoryInvalid({
            path: storedPath(path, directory, error.kind, error.hash),
            reason:
              error._tag === "History.StoreMissing" ? `${error.kind} is missing` : error.reason,
          }),
    );

  /**
   * Save a stable, unvalidated tree before sync can change it. Originals, executable modes,
   * directories and symlinks use the verbatim tree format. Root Git/control exclusions and
   * .gitignore remain in effect. Returning to older content records a new revision that shares
   * the older tree.
   */
  const capture = Effect.fn("AuthorHistory.capture")(function* (root: WorkspaceRoot) {
    const insideRoot = (candidatePath: string) =>
      candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`);
    if (insideRoot(home))
      return yield* new AuthorHistoryInvalid({
        path: directory,
        reason: "history cannot be inside its workspace",
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
          reason: "history resolves inside its workspace",
        });
    }
    const journalFile = yield* links
      .lstat(journalPath)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
    if (journalFile?.type === "SymbolicLink")
      return yield* new AuthorHistoryInvalid({
        path: journalPath,
        reason: "journal cannot be a symbolic link",
      });
    // Broken device-local metadata must not prevent backing up the authored files. This is
    // path-provenance fallback only; it neither creates nor repairs a workspace identity.
    const workspaceId = yield* workspaces.readIdentity(root).pipe(
      Effect.map((identity) =>
        Option.getOrUndefined(Option.map(identity, (value) => value.workspaceId)),
      ),
      Effect.catchTag("AuthorWorkspaceMetadataInvalid", () => Effect.succeed(undefined)),
    );
    // Machine identity may need the Library writer. Never acquire that writer while holding the
    // journal permit/transaction: promotion saves history under its Library writer, so the reverse
    // order would deadlock.
    const identity = yield* Effect.result(
      Effect.gen(function* () {
        const settings = yield* MachineSettings.read(home);
        return settings.machineId ?? (yield* MachineSettings.ensureIdentity(home));
      }),
    );

    const save = (latest: History.RevisionId | undefined) =>
      Effect.gen(function* () {
        const readStable = Effect.gen(function* () {
          const tree = yield* walkAuthorTree(root, "verbatim");
          const treeHash = yield* History.treeHash(tree);
          const again = yield* History.treeHash(yield* walkAuthorTree(root, "verbatim"));
          if (treeHash !== again) return yield* new LocalFilesChangedDuringSync();
          return { tree, treeHash };
        });
        const { tree, treeHash } = yield* readStable.pipe(
          Effect.retry({
            times: 2,
            while: (error) => error._tag === "LocalFilesChangedDuringSync",
          }),
        );
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

  const loadBindings = Effect.gen(function* () {
    const text = yield* fs.readFileString(bindingsPath).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isNone(text))
      return { schema: "skit.sync-bindings.v4", workspaces: {} } satisfies SyncBindings;
    const document = yield* Schema.decodeUnknownEffect(BindingsDocument)(text.value).pipe(
      Effect.mapError(
        (error) => new AuthorSyncStateInvalid({ path: bindingsPath, reason: String(error) }),
      ),
    );
    // No migration: author sync never shipped with these formats (A5).
    if (document.schema !== "skit.sync-bindings.v4")
      return yield* new AuthorSyncStateInvalid({
        path: bindingsPath,
        reason: `it is ${document.schema}, written by an unreleased build; this build reads only skit.sync-bindings.v4`,
      });
    return document;
  });
  const entry = (bindings: SyncBindings, key: SyncKey) =>
    bindings.workspaces[key.workspaceId]?.[key.locator] ?? Sync.Idle.make({ base: null });

  const read = Effect.fn("AuthorHistory.syncState.read")(function* (key: SyncKey) {
    return entry(yield* loadBindings, key);
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
  ) {
    return yield* HomeLock.withLock(
      home,
      Effect.gen(function* () {
        // Refuse before writing when the lease is no longer held.
        yield* lease.revision;
        const bindings = yield* loadBindings;
        const found = entry(bindings, key);
        if (!sameState(found, from)) return yield* new AuthorSyncStateConflict({ key, found });
        const next: SyncBindings = {
          schema: "skit.sync-bindings.v4",
          workspaces: {
            ...bindings.workspaces,
            [key.workspaceId]: { ...bindings.workspaces[key.workspaceId], [key.locator]: to },
          },
        };
        yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const staging = yield* fs.makeTempDirectoryScoped({
              directory: home,
              prefix: ".sync-state-",
            });
            const temporary = path.join(staging, "state.json");
            const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
            // The bindings are built from decoded states, so failing to encode them is a defect.
            const text = yield* Schema.encodeEffect(Schema.fromJsonString(SyncBindings))(next).pipe(
              Effect.orDie,
            );
            yield* file.writeAll(new TextEncoder().encode(text));
            yield* file.sync;
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* fs.rename(temporary, bindingsPath);
                const folder = yield* fs.open(home, { flag: "r" });
                yield* folder.sync;
              }),
            );
          }),
        );
        return yield* lease.advance;
      }),
    );
  });

  const save = Effect.fn("AuthorHistory.syncState.save")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    change:
      | {
          readonly from: Sync.SyncState;
          readonly to: Exclude<Sync.SyncState, { readonly _tag: "Writing" }>;
        }
      | { readonly from: Sync.SyncState; readonly reset: CreateReceipt },
  ) {
    if ("reset" in change) {
      yield* step(lease, key, change.from, Sync.Idle.make({ base: null }));
      return;
    }
    if (!Sync.allowsStep(change.from, change.to))
      return yield* new AuthorSyncStateIllegal({ key, from: change.from, to: change.to });
    yield* step(lease, key, change.from, change.to);
  });

  const prepareWrite = Effect.fn("AuthorHistory.syncState.prepareWrite")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    change: {
      readonly from: Sync.SyncState;
      readonly to: Extract<Sync.SyncState, { readonly _tag: "Writing" }>;
    },
  ) {
    if (!Sync.allowsStep(change.from, change.to))
      return yield* new AuthorSyncStateIllegal({ key, from: change.from, to: change.to });
    // Reading verifies each tree against its hash, so a missing or corrupt tree refuses here.
    yield* Effect.forEach([change.to.from, change.to.to], engineStore.tree, {
      discard: true,
    }).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
    const revision = yield* step(lease, key, change.from, change.to);
    return PreparedWrite.make({
      key,
      from: change.to.from,
      to: change.to.to,
      ownerId: lease.ownerId,
      revision,
    });
  });

  const service: AuthorHistoryShape = {
    capture: (root) => capture(root).pipe(Effect.provide(context)),
    retain: (tree) =>
      engineStore.putTree(tree).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure)),
    engineStore,
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
