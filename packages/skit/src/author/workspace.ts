/**
 * AuthorWorkspace: the owner of an author workspace's own state (ADR-0026).
 *
 * It owns <root>/.skit/workspace.json, .skit/.gitignore, .skit/connection.json,
 * .skit/lock.sqlite, .skit/stage-*, <root>/skit.remote.json, and the file writes sync makes.
 * Callers read with `read` / `readIdentity` and write only through a WorkspaceLease from
 * `acquire`, so every write runs under the per-workspace lock (ADR-0026).
 */
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import {
  AUTHOR_WORKSPACE_METADATA_FILE,
  COLLECTION_CONTROL_DIRECTORY,
} from "../artifact/control-files.js";
import { AuthorIgnoreRepository } from "../artifact/plain-author-ignore.js";
import * as History from "../history/history.js";
import { LinkStat } from "../platform/link-stat.js";
import { type SkitContractError } from "../api/contracts.js";
import { SourceProcess } from "../platform/source-process.js";
import { type TreeError } from "../shared/tree-error.js";
import { lockFile } from "../platform/file-lock.js";
import { syncPaths, writeJsonExclusive, writeRawAtomic } from "../platform/atomic-write.js";
import { isErrno } from "../shared/errno.js";
import {
  AuthorWorkspaceMetadataInvalid,
  AuthorRemoteMetadataInvalid,
  type AuthorLocalPathUnchecked,
  type AuthorNonNfcPathUnsupported,
  type AuthorNormalizationTwin,
  type LocalFilesChangedDuringSync,
} from "./failures.js";

import { AuthorVisibility, AuthorRemoteHome, normalizeRemote } from "./remote.js";

import { writeWorkspaceTree } from "./write-tree.js";
import type { WriteCheckpoint } from "./history.js";
import {
  WorkspaceId,
  Identity,
  readAuthorIdentity,
  readAuthorRemote,
} from "./workspace-metadata.js";
export { WorkspaceId, Identity } from "./workspace-contracts.js";
import {
  WorkspaceRoot,
  Workspace,
  SyncKey,
  Connecting,
  type Connected,
  Connection,
  type Leftover,
  AuthorSyncStateInvalid,
  AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
  AuthorWorkspaceUnsafe,
  AuthorWorkspaceBusy,
  AuthorWorkspaceInvariantFailed,
} from "./workspace-contracts.js";
export {
  WorkspaceRoot,
  SyncKey,
  Connecting,
  AuthorSyncStateInvalid,
  AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
} from "./workspace-contracts.js";

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/** What the create call proved: this request id created this destination. */
export interface CreateReceipt {
  readonly requestId: string;
  readonly remote: AuthorRemoteHome;
}

/** The connection's one transition: each case is a pair the code really performs. */
type ConnectionTransition =
  | {
      readonly from: Extract<Connection, { _tag: "Unconnected" }>;
      readonly to: {
        readonly _tag: "Connecting";
        readonly remote: AuthorRemoteHome;
        readonly visibility: AuthorVisibility;
      };
    }
  | {
      readonly from: Connecting;
      readonly to: { readonly _tag: "Unconnected" };
    }
  | {
      readonly from: Connecting;
      readonly to: { readonly _tag: "Connected" };
      readonly receipt: CreateReceipt;
    }
  | {
      readonly from: Connected & { readonly leftover: Extract<Leftover, { _tag: "Matching" }> };
      readonly to: { readonly _tag: "Connected" };
    };

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────

export type WorkspaceReadError =
  | AuthorWorkspaceMetadataInvalid
  | AuthorRemoteMetadataInvalid
  | AuthorSyncStateInvalid
  | PlatformError.PlatformError;

type WriteTreeError =
  | AuthorWorkspaceConflict
  | WorkspaceReadError
  | LocalFilesChangedDuringSync
  | SkitContractError
  | AuthorLocalPathUnchecked
  | AuthorNormalizationTwin
  | AuthorNonNfcPathUnsupported
  | TreeError
  | PlatformError.PlatformError;

// ── Surface ────────────────────────────────────────────────────────────────────────────────────

/**
 * The exclusive per-workspace lease, across processes (ADR-0026:228-236). Valid only inside the
 * scope that acquired it; not reentrant. Lock order: this lease, then the home lock, then the
 * Library writer.
 */
export interface WorkspaceLease {
  readonly root: WorkspaceRoot;
  /** A fresh random id per hold of the lease. */
  readonly ownerId: string;
  /** Changes on every checkpoint step (advance). */
  readonly revision: Effect.Effect<number>;
  /** For AuthorHistory only: record a checkpoint step under this hold; returns the new revision. */
  readonly advance: Effect.Effect<number>;
  /**
   * Give an unidentified workspace its identity, adopting the id of a Collection the Library
   * already imported from this root when there is one (A3). Fails AuthorWorkspaceConflict if an
   * identity is already on disk; an identity is never replaced.
   */
  readonly register: (
    adopt: Option.Option<WorkspaceId>,
  ) => Effect.Effect<Identity, AuthorWorkspaceConflict | WorkspaceReadError>;
  /** The connection lifecycle. Every write is flushed before returning. Returns the new state. */
  readonly transition: (
    change: ConnectionTransition,
  ) => Effect.Effect<Connection, AuthorWorkspaceConflict | WorkspaceReadError>;
  /**
   * History-only write boundary. Its private checkpoint proves the saved tree pair.
   * Any attempt consumes the checkpoint. Public preparation returns a bound apply operation.
   */
  readonly writeTree: (change: {
    readonly prepared: WriteCheckpoint;
    readonly from: History.Tree;
    readonly to: History.Tree;
  }) => Effect.Effect<void, WriteTreeError>;
}

export interface AuthorWorkspaceShape {
  /** The only way to mint a WorkspaceRoot: Path.resolve, then realPath, of an existing directory. */
  readonly resolveRoot: (
    input: string,
  ) => Effect.Effect<WorkspaceRoot, AuthorWorkspaceRootInvalid | PlatformError.PlatformError>;
  /** One read of identity and connection. Never writes, so a preview needs no lease. */
  readonly read: (root: WorkspaceRoot) => Effect.Effect<Workspace, WorkspaceReadError>;
  /** Identity only, from .skit/workspace.json; absent (or a gone root) is None. */
  readonly readIdentity: (
    root: WorkspaceRoot,
  ) => Effect.Effect<
    Option.Option<Identity>,
    AuthorWorkspaceMetadataInvalid | PlatformError.PlatformError
  >;
  /** Take the lease until the scope closes. Never waits: a held lease fails AuthorWorkspaceBusy. */
  readonly acquire: (
    root: WorkspaceRoot,
  ) => Effect.Effect<
    WorkspaceLease,
    AuthorWorkspaceBusy | AuthorWorkspaceUnsafe | PlatformError.PlatformError,
    Scope.Scope
  >;
}

/** What AuthorWorkspace.layer requires (the workspace owner captures these dependencies). */
type Requires =
  | FileSystem.FileSystem
  | Path.Path
  | LinkStat
  | SourceProcess
  | AuthorIgnoreRepository
  | Digest.Digest
  | SecureRandom.SecureRandom;

/** A lease hold: the lock's own scope while held. */
type Hold =
  | { readonly state: "held"; readonly lock: Scope.Closeable }
  | { readonly state: "closed" };

const make = Effect.gen(function* () {
  // Only the services: the whole context would carry the layer's own Scope into every call.
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    LinkStat,
    SourceProcess,
    AuthorIgnoreRepository,
    Digest.Digest,
    SecureRandom.SecureRandom,
  )(yield* Effect.context<Requires>());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* LinkStat;
  const random = yield* SecureRandom.SecureRandom;
  const control = (root: string) => path.join(root, COLLECTION_CONTROL_DIRECTORY);
  const identityPath = (root: string) => path.join(control(root), AUTHOR_WORKSPACE_METADATA_FILE);
  const connectionPath = (root: string) => path.join(control(root), "connection.json");
  const remotePath = (root: string) => path.join(root, "skit.remote.json");
  const sameRemote = Schema.toEquivalence(AuthorRemoteHome);
  const sameConnection = Schema.toEquivalence(Connection);
  const lstat = (target: string) =>
    links.lstat(target).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );

  const resolveRoot = Effect.fn("AuthorWorkspace.resolveRoot")(function* (input: string) {
    const real = yield* fs
      .realPath(path.resolve(input))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new AuthorWorkspaceRootInvalid({ input })),
        ),
      );
    if ((yield* fs.stat(real)).type !== "Directory")
      return yield* new AuthorWorkspaceRootInvalid({ input });
    return WorkspaceRoot.make(real);
  });

  const readIdentity = readAuthorIdentity;

  /** .skit/connection.json as a Connecting checkpoint, canonical or invalid. */
  const decodeCheckpoint = Effect.fn("AuthorWorkspace.decodeCheckpoint")(function* (
    file: string,
    text: string,
  ) {
    const checkpoint = yield* Schema.decodeEffect(Schema.fromJsonString(Connecting), {
      onExcessProperty: "error",
    })(text).pipe(
      Effect.mapError(
        (error) =>
          new AuthorSyncStateInvalid({
            path: file,
            reason: { _tag: "InvalidData", failure: error },
          }),
      ),
    );
    const normalized = yield* normalizeRemote(checkpoint.remote).pipe(
      Effect.mapError(
        (error) =>
          new AuthorSyncStateInvalid({
            path: file,
            reason: { _tag: "RemoteInvalid", failure: error },
          }),
      ),
    );
    if (!sameRemote(normalized, checkpoint.remote))
      return yield* new AuthorSyncStateInvalid({
        path: file,
        reason: { _tag: "NoncanonicalDestination" },
      });
    return checkpoint;
  });

  const read = Effect.fn("AuthorWorkspace.read")(function* (root: WorkspaceRoot) {
    const identity = yield* readIdentity(root);
    const remote = yield* readAuthorRemote(root);
    const file = connectionPath(root);
    const text = yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT") ? Effect.succeedNone : Effect.fail(error),
      ),
    );
    const connection: Connection = Option.isSome(remote)
      ? {
          _tag: "Connected",
          remote: remote.value,
          leftover: Option.isNone(text)
            ? { _tag: "None" }
            : yield* decodeCheckpoint(file, text.value).pipe(
                Effect.map((checkpoint): Leftover =>
                  sameRemote(checkpoint.remote, remote.value)
                    ? { _tag: "Matching", checkpoint }
                    : { _tag: "Mismatched", checkpoint },
                ),
                Effect.catchTag("AuthorSyncStateInvalid", (error) =>
                  Effect.succeed<Leftover>({ _tag: "Invalid", error }),
                ),
              ),
        }
      : Option.isNone(text)
        ? { _tag: "Unconnected" }
        : yield* decodeCheckpoint(file, text.value);
    return Workspace.make({ root, identity, connection });
  });

  /**
   * Take the lock, after checking the root and .skit are what they claim to be. Creates .skit
   * (0700) and its .gitignore (`*`) if absent. Returns the scope that holds the lock.
   */
  const take = Effect.fn("AuthorWorkspace.take")(function* (root: WorkspaceRoot) {
    if ((yield* fs.realPath(root)) !== root)
      return yield* new AuthorWorkspaceUnsafe({
        path: root,
        reason: { _tag: "RootChanged" },
      });
    const directory = control(root);
    if (Option.isNone(yield* lstat(directory))) {
      yield* fs
        .makeDirectory(directory, { mode: 0o700 })
        .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
      yield* syncPaths([root]);
    }
    if (!Option.exists(yield* lstat(directory), (info) => info.type === "Directory"))
      return yield* new AuthorWorkspaceUnsafe({
        path: directory,
        reason: { _tag: "ControlNotDirectory" },
      });
    const ignore = path.join(directory, ".gitignore");
    if (Option.isNone(yield* lstat(ignore))) {
      yield* fs.writeFileString(ignore, "*\n", { flag: "wx", mode: 0o600 }).pipe(
        Effect.uninterruptible,
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
      );
      yield* syncPaths([ignore, directory]);
    }
    const lockPath = path.join(directory, "lock.sqlite");
    if (Option.exists(yield* lstat(lockPath), (info) => info.type !== "File"))
      return yield* new AuthorWorkspaceUnsafe({
        path: lockPath,
        reason: { _tag: "LockNotFile" },
      });
    const lock = yield* Scope.make();
    yield* lockFile(lockPath).pipe(
      Scope.provide(lock),
      Effect.catchTags({
        FileLockBusy: () => Effect.fail(new AuthorWorkspaceBusy({ root })),
        FileLockFailed: (error) =>
          Effect.fail(
            new AuthorWorkspaceUnsafe({
              path: lockPath,
              reason: { _tag: "LockFailed", cause: error.cause },
            }),
          ),
      }),
      Effect.onError(() => Scope.close(lock, Exit.void)),
    );
    return lock;
  });

  const acquire = Effect.fn("AuthorWorkspace.acquire")(function* (root: WorkspaceRoot) {
    // Closing the lease waits for any method already holding this permit.
    const permit = yield* Semaphore.make(1);
    const hold = yield* Effect.acquireRelease(
      take(root).pipe(Effect.flatMap((lock) => Ref.make<Hold>({ state: "held", lock }))),
      // Scope close releases only what is still held.
      (ref) =>
        permit.withPermit(
          Ref.getAndSet(ref, { state: "closed" }).pipe(
            Effect.flatMap((last) =>
              last.state === "held" ? Scope.close(last.lock, Exit.void) : Effect.void,
            ),
          ),
        ),
    );
    // Stage folders a crashed writeTree left behind. Nothing else writes under the lease yet.
    const directory = control(root);
    for (const name of yield* fs.readDirectory(directory))
      if (name.startsWith("stage-"))
        yield* fs.remove(path.join(directory, name), { recursive: true });
    const ownerId = yield* random.uuidV4();
    const revision = yield* Ref.make(0);
    // The revision whose write checkpoint was last presented: each is good for one attempt.
    const presented = yield* Ref.make(-1);
    const invalid = (reason: AuthorWorkspaceInvariantFailed["reason"]) =>
      Effect.die(new AuthorWorkspaceInvariantFailed({ root, reason }));
    const held = Ref.get(hold).pipe(
      Effect.flatMap((current) =>
        current.state === "held" ? Effect.void : invalid({ _tag: "LeaseClosed" }),
      ),
    );

    const register = Effect.fn("AuthorWorkspace.register")(function* (
      adopt: Option.Option<WorkspaceId>,
    ) {
      yield* held;
      if (Option.isSome(yield* readIdentity(root)))
        return yield* new AuthorWorkspaceConflict({ root, found: yield* read(root) });
      const file = identityPath(root);
      const workspaceId = Option.isSome(adopt)
        ? adopt.value
        : WorkspaceId.make(`workspace_${(yield* random.uuidV4()).replaceAll("-", "")}`);
      yield* writeJsonExclusive(file, {
        schema: "skit.author-workspace.v1",
        workspace_id: workspaceId,
      });
      yield* syncPaths([file, control(root), root]);
      return Identity.make({ workspaceId });
    });

    const transition = Effect.fn("AuthorWorkspace.transition")(function* (
      change: ConnectionTransition,
    ) {
      yield* held;
      const found = yield* read(root);
      if (!sameConnection(found.connection, change.from))
        return yield* new AuthorWorkspaceConflict({ root, found });
      const checkpoint = connectionPath(root);
      const removeCheckpoint = fs
        .remove(checkpoint)
        .pipe(Effect.andThen(syncPaths([control(root)])));
      if (change.to._tag === "Connecting") {
        const connecting = Connecting.make({
          remote: change.to.remote,
          visibility: change.to.visibility,
          requestId: yield* random.uuidV4(),
        });
        yield* writeJsonExclusive(checkpoint, connecting);
        // Flush the checkpoint and both directory entries before any network mutation.
        yield* syncPaths([checkpoint, control(root), root]);
        return connecting;
      }
      if (change.to._tag === "Unconnected") {
        yield* removeCheckpoint;
        return Connection.make({ _tag: "Unconnected" });
      }
      if ("receipt" in change) {
        // Only the request this checkpoint replays may connect it (A4).
        if (
          change.receipt.requestId !== change.from.requestId ||
          !sameRemote(change.receipt.remote, change.from.remote)
        )
          return yield* new AuthorWorkspaceConflict({ root, found });
        const file = remotePath(root);
        yield* writeRawAtomic(
          file,
          `${JSON.stringify(change.from.remote, null, 2)}\n`,
          false,
          0o644,
        );
        yield* syncPaths([file, root]);
        yield* removeCheckpoint;
        return Connection.make({
          _tag: "Connected",
          remote: change.from.remote,
          leftover: { _tag: "None" },
        });
      }
      // A matching leftover beside the connected remote: only connection.json goes.
      if (found.connection._tag !== "Connected")
        return yield* new AuthorWorkspaceConflict({ root, found });
      yield* removeCheckpoint;
      return Connection.make({
        _tag: "Connected",
        remote: found.connection.remote,
        leftover: { _tag: "None" },
      });
    });

    const writeTree = Effect.fn("AuthorWorkspace.writeTree")(function* (change: {
      readonly prepared: WriteCheckpoint;
      readonly from: History.Tree;
      readonly to: History.Tree;
    }) {
      yield* held;
      const { prepared } = change;
      const current = yield* Ref.get(revision);
      if (prepared.ownerId !== ownerId)
        return yield* invalid({ _tag: "WriteNotOwned", key: prepared.key });
      if (prepared.revision !== current)
        return yield* invalid({ _tag: "CheckpointChanged", key: prepared.key });
      // This is the current hold's write checkpoint: any attempt, failed or partial, uses it up.
      if ((yield* Ref.getAndSet(presented, current)) === current)
        return yield* invalid({ _tag: "WriteAlreadyUsed", key: prepared.key });
      const identity = yield* readIdentity(root);
      if (!Option.exists(identity, (value) => value.workspaceId === prepared.key.workspaceId))
        return yield* new AuthorWorkspaceConflict({ root, found: yield* read(root) });
      const hashes = yield* Effect.all([
        History.treeHash(change.from),
        History.treeHash(change.to),
      ]);
      if (hashes[0] !== prepared.from || hashes[1] !== prepared.to)
        return yield* invalid({ _tag: "TreesDiffer", key: prepared.key });
      yield* writeWorkspaceTree(root, change.from, change.to);
    });

    const lease: WorkspaceLease = {
      root,
      ownerId,
      revision: permit.withPermit(held.pipe(Effect.andThen(Ref.get(revision)))),
      advance: permit.withPermit(
        held.pipe(Effect.andThen(Ref.updateAndGet(revision, (value) => value + 1))),
      ),
      register: (change) => permit.withPermit(register(change)).pipe(Effect.provide(context)),
      transition: (change) => permit.withPermit(transition(change)).pipe(Effect.provide(context)),
      writeTree: (change) => permit.withPermit(writeTree(change)).pipe(Effect.provide(context)),
    };
    return lease;
  });

  const service: AuthorWorkspaceShape = {
    resolveRoot,
    read: (root) => read(root).pipe(Effect.provide(context)),
    readIdentity: (root) => readIdentity(root).pipe(Effect.provide(context)),
    acquire: (root) => acquire(root).pipe(Effect.provide(context)),
  };
  return service;
});

export class AuthorWorkspace extends Context.Service<AuthorWorkspace, AuthorWorkspaceShape>()(
  "skit/author/AuthorWorkspace",
) {
  static readonly layer = Layer.effect(AuthorWorkspace, make);
}

export { AuthorWorkspaceUnsafe };
export type { AuthorWorkspaceBusy };
