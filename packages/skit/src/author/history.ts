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
 * It owns immutable history and the Author timeline, workspace and
 * checkpoint/inventory rows in <home>/library.sqlite. Callers save workspace files with `refresh`
 * and `saveTree`, run sync against `engineStore`, and step checkpoints through `syncState`.
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
  Schema,
  Semaphore,
} from "effect";
import { Digest, SecureRandom } from "effect/crypto";

import { AuthorIgnoreRepository } from "../artifact/plain-author-ignore.js";
import * as History from "../history/history.js";
import { HomeBusy } from "../platform/lock-failures.js";
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
import { AuthorWorkspaceInvariantFailed } from "./workspace-contracts.js";
import { makeHistoryStore } from "./history-store.js";
import { fileBytesPath } from "../artifact/file-bytes.js";
import { saveReceivedHistory, writeHistoryEvent } from "./history-journal.js";
import { libraryDatabasePath } from "../library/store/database.js";
import * as AuthorState from "./state-store.js";
import { makeRemovalCheck, scanAuthorInventory, type RemovalDecision } from "./inventory.js";

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

export type RefreshError =
  | AuthorHistoryInvalid
  | AuthorHistoryBusy
  | LocalFilesChangedDuringSync
  | AuthorWorkspaceAlreadyRegistered
  | Effect.Error<ReturnType<typeof MachineSettings.ensureIdentity>>
  | HomeBusy // MachineSettings.ensureIdentity takes the home lock (withHomeLock today)
  | TreeError
  | PlatformError.PlatformError;

type SyncStateError =
  | AuthorSyncStateInvalid
  | AuthorHistoryInvalid
  | HomeBusy
  | PlatformError.PlatformError;

// ── Journal ────────────────────────────────────────────────────────────────────────────────────

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
   * changed, with a journal event in one SQLite transaction. An ordinary unchanged scan records
   * nothing. After sync, source supplies copied paths' times, correcting an earlier background
   * scan if needed. Needs no lease: it writes only home state.
   */
  readonly refresh: (
    root: WorkspaceRoot,
    source?: History.RevisionId,
  ) => Effect.Effect<SavedRevision, RefreshError>;
  /** Save a verified pure pull as the local head and ACK, only if its guards still hold. */
  readonly saveReceived: (
    lease: WorkspaceLease,
    key: SyncKey,
    change: { readonly before: History.RevisionId; readonly received: History.RevisionId },
  ) => Effect.Effect<boolean, RefreshError | SyncStateError | WorkspaceReadError>;
  /** Store a tree (immutable, content-addressed, idempotent). */
  readonly saveTree: (
    tree: History.Tree,
  ) => Effect.Effect<History.TreeHash, AuthorHistoryInvalid | HomeBusy>;
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
     * Normal Idle/Sending steps in one short transaction under the home lock, then
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
  const workspaces = yield* AuthorWorkspace;
  const home = path.resolve(config.home);
  const directory = path.join(home, "history");
  const syncStatePath = libraryDatabasePath(home);
  const { store: engineStore, keepTree } = yield* makeHistoryStore(directory);
  // Scans serialize across processes without holding the shared database writer through file work.
  const writers = yield* Semaphore.make(1);
  const sameState = Schema.toEquivalence(Sync.SyncState);
  const removalCheck = makeRemovalCheck();
  const inventoryRoots = new Map<string, WorkspaceId>();

  // Stored history that cannot be read back is unusable history, whatever the store's reason.
  const storeFailure = (
    error: History.StoreError,
  ): Effect.Effect<never, AuthorHistoryInvalid | HomeBusy> => {
    if (error._tag === "History.StoreFailed" && Schema.is(HomeBusy)(error.cause))
      return Effect.fail(error.cause);
    const blob =
      error._tag === "History.StoreCorrupt" && "blob" in error.reason
        ? error.reason.blob
        : undefined;
    return Effect.fail(
      new AuthorHistoryInvalid({
        path: blob === undefined ? libraryDatabasePath(home) : fileBytesPath(home, blob),
        reason: { _tag: "StoreFailure", failure: error },
      }),
    );
  };

  /**
   * Save a stable, unvalidated tree before sync can change it. Originals, executable modes,
   * directories and symlinks use the verbatim tree format. Root Git/control exclusions and
   * .gitignore remain in effect. Returning to older content records a new revision that shares
   * the older tree.
   */
  const refresh = Effect.fn("AuthorHistory.refresh")(function* (
    root: WorkspaceRoot,
    source?: History.RevisionId,
  ) {
    const insideRoot = (candidatePath: string) =>
      candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`);
    if (insideRoot(home))
      return yield* new AuthorHistoryInvalid({
        path: directory,
        reason: { _tag: "HistoryInsideWorkspace", workspace: root, resolved: false },
      });
    for (const folder of [home, directory]) {
      yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
      if (insideRoot(yield* fs.realPath(folder)))
        return yield* new AuthorHistoryInvalid({
          path: directory,
          reason: { _tag: "HistoryInsideWorkspace", workspace: root, resolved: true },
        });
    }
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
          if (previous && unchanged && source === undefined) return { ...previous, treeHash };
        }
        const recorded = yield* History.record(
          engineStore,
          tree,
          previous ? [previous.id] : [],
          {
            device: yield* Effect.fromResult(identity),
            at: yield* Clock.currentTimeMillis,
          },
          { source },
        );
        return { ...recorded, treeHash };
      }).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));

    // A missing device identity must not prevent keeping the authored bytes, nor wait for
    // another home writer before reporting its failure. No timeline event can name that device.
    if (Result.isFailure(identity)) {
      const { tree } = yield* scanAuthorWorkspace(root);
      yield* keepTree(tree).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
      return yield* identity.failure;
    }
    const saved = yield* writeHistoryEvent(writers, home, root, workspaceId, save);
    // Shared rows and immutable files are durable before acknowledgement; persist directory entries.
    yield* syncPaths([directory, home, path.dirname(home)]);
    return { id: saved.id, revision: saved.revision, treeHash: saved.treeHash };
  });

  const saveReceived = Effect.fn("AuthorHistory.saveReceived")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    change: { readonly before: History.RevisionId; readonly received: History.RevisionId },
  ) {
    const revision = yield* lease.revision;
    const identity = yield* workspaces.readIdentity(lease.root);
    if (Option.isNone(identity) || identity.value.workspaceId !== key.workspaceId) return false;
    const received = yield* engineStore
      .revision(change.received)
      .pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
    const tree = yield* engineStore
      .tree(received.tree)
      .pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
    const saved = yield* saveReceivedHistory(
      writers,
      home,
      lease.root,
      key,
      change,
      Effect.gen(function* () {
        const actual = yield* scanAuthorWorkspace(lease.root);
        return (
          (yield* lease.revision) === revision &&
          actual.treeHash === received.tree &&
          Schema.toEquivalence(History.Tree)(History.sortTree(actual.tree), History.sortTree(tree))
        );
      }).pipe(Effect.catchTag("LocalFilesChangedDuringSync", () => Effect.succeed(false))),
      lease.revision.pipe(Effect.map((current) => current === revision)),
    );
    if (saved) yield* lease.advance;
    return saved;
  });

  const read = (key: SyncKey) => AuthorState.readAuthorSyncState(home, key);
  const readBackup = (key: SyncKey) => AuthorState.readAuthorBackup(home, key);

  /**
   * One checkpoint step under the home lock: refuse unless the saved entry still equals `from`,
   * save only that row in the shared transaction, then advance the lease.
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
        yield* AuthorState.withAuthorStateTransaction(
          home,
          Effect.gen(function* () {
            const found = yield* read(key);
            if (!sameState(found, from)) return yield* new AuthorSyncStateConflict({ key, found });
            yield* AuthorState.saveAuthorSyncState(home, key, to, resetBackup);
          }),
        );
        return yield* lease.advance;
      }),
    );
  });

  const saveBackup = Effect.fn("AuthorHistory.backupState.save")(function* (
    lease: WorkspaceLease,
    key: SyncKey,
    change: { readonly from: History.RevisionId | null; readonly to: History.RevisionId },
  ) {
    yield* lease.revision;
    const found = yield* readBackup(key);
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
    yield* HomeLock.withLock(
      home,
      Effect.gen(function* () {
        yield* lease.revision;
        yield* AuthorState.withAuthorStateTransaction(
          home,
          Effect.gen(function* () {
            const current = yield* readBackup(key);
            if (current !== change.from)
              return yield* new AuthorBackupStateConflict({ key, found: current });
            yield* AuthorState.saveAuthorBackup(key, change.to);
          }),
        );
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
    const savedKey = { ...key };
    yield* lease.revision;
    const workspace = yield* workspaces.read(lease.root);
    if (!Option.exists(workspace.identity, (identity) => identity.workspaceId === key.workspaceId))
      return yield* new AuthorWorkspaceConflict({ root: lease.root, found: workspace });
    let resumed = "trees" in change ? change.from.next : undefined;
    if ("trees" in change && change.mergedRevision !== undefined) {
      const result = yield* engineStore
        .revision(change.mergedRevision)
        .pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
      const target =
        change.from.next._tag === "Sending" ? change.from.next.revision : change.from.next.base;
      if (result.tree !== change.trees.to || !result.parents.includes(target))
        return yield* Effect.die(
          new AuthorWorkspaceInvariantFailed({
            root: lease.root,
            reason: { _tag: "TreesDiffer", key: savedKey },
          }),
        );
      // Recovery can advance only a descendant of its original destination;
      // callers cannot choose a different compare-and-swap base or completion state.
      resumed = Sync.Sending.make({ base: change.from.next.base, revision: change.mergedRevision });
    }
    const writing =
      "trees" in change
        ? Sync.Writing.make({ ...change.from, ...change.trees, next: resumed!, merged: true })
        : change.to;
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
        const previous = yield* AuthorState.readAuthorInventory(home, workspaceId);
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
          yield* AuthorState.withAuthorStateTransaction(
            home,
            AuthorState.saveAuthorInventory(home, workspaceId, accepted),
          );
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
    refresh: (root, source) =>
      refresh(root, source).pipe(
        Effect.onError(() => resetRemovalGrace(root)),
        Effect.provide(context),
      ),
    saveReceived: (lease, key, change) =>
      saveReceived(lease, key, change).pipe(Effect.provide(context)),
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
  error._tag === "History.StoreFailed" && Schema.is(HomeBusy)(error.cause)
    ? error.cause
    : new AuthorHistoryInvalid({
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
  const previous = yield* AuthorState.readAuthorInventory(home, WorkspaceId.make(workspaceId));
  return (yield* makeRemovalCheck().check(
    workspaceId,
    previous,
    yield* scanAuthorInventory(tree, previous?.inventory),
  )).decision;
});

export type { AuthorHistoryBusy, AuthorSyncStateConflict, AuthorBackupStateConflict };
