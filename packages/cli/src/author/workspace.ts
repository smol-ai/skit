/**
 * AuthorWorkspace: the owner of an author workspace's own state (architecture/author.ts).
 *
 * It owns <root>/.skit/workspace.json, .skit/.gitignore, .skit/connection.json,
 * .skit/lock.sqlite, .skit/stage-*, <root>/skit.remote.json, and the file writes sync makes.
 * Callers read with `read` / `readIdentity` and write only through a WorkspaceLease from
 * `acquire`, so every write runs under the per-workspace lock (decisions.md A8).
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
  AuthorIgnoreRepository,
  FailureTypeId,
  History,
  LinkStat,
  type SkitContractError,
  type SkitFailure,
  SourceProcess,
  type TreeError,
  acquireFileLock,
  syncPaths,
  writeJsonAtomic,
  writeJsonExclusive,
  writeRawAtomic,
} from "@smolai/skit-core";
import { isErrno } from "../platform/errno.js";
import { AuthorWorkspaceMetadataInvalid } from "../library/failures.js";
import {
  AuthorRemoteMetadataInvalid,
  type AuthorLocalPathNotObserved,
  type AuthorNonNfcPathUnsupported,
  type AuthorNormalizationTwin,
  type LocalFilesChangedDuringSync,
} from "../registry/failures.js";
import { AuthorVisibility } from "../workflows/author/sync-contract.js";
import { AuthorRemoteHome, normalizeRemote } from "./remote.js";
import { writeWorkspaceTree } from "./write-tree.js";
import type { PreparedWrite } from "./history.js";

// ── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/** realPath(resolve(input)) of an existing directory. Minted only by AuthorWorkspace.resolveRoot. */
const WorkspaceRoot = Schema.String.pipe(Schema.brand("WorkspaceRoot"));
export type WorkspaceRoot = typeof WorkspaceRoot.Type;

/** `workspace_<32 hex>`. Device-local, never portable (ADR-0026). */
export const WorkspaceId = Schema.String.check(Schema.isPattern(/^workspace_[a-f0-9]{32}$/u)).pipe(
  Schema.brand("WorkspaceId"),
);
export type WorkspaceId = typeof WorkspaceId.Type;

/**
 * Any identity can be backed up and synced; only Registered may be installed. IdentityOnly is
 * the absent `registration` key. Removing is the durable removal intent (A15); Removed is the
 * opt-out nothing automatic resurrects.
 */
const Registration = Schema.Literals(["IdentityOnly", "Registered", "Removing", "Removed"]);
export type Registration = typeof Registration.Type;

export const Identity = Schema.Struct({ workspaceId: WorkspaceId, registration: Registration });
export type Identity = typeof Identity.Type;
type IdentityIn<R extends Registration> = Identity & { readonly registration: R };

/** The stored `registration` value of each registration; IdentityOnly stores none. */
const storedRegistration = {
  IdentityOnly: undefined,
  Registered: "registered",
  Removing: "removing",
  Removed: "removed",
} as const;

/** .skit/workspace.json, skit.author-workspace.v1. */
const WorkspaceDocument = Schema.Struct({
  schema: Schema.Literal("skit.author-workspace.v1"),
  workspace_id: WorkspaceId,
  registration: Schema.optionalKey(Schema.Literals(["registered", "removing", "removed"])),
});

/** Saved recovery state must be readable before sync may change files or the Registry. */
export class AuthorSyncStateInvalid
  extends Schema.TaggedError<AuthorSyncStateInvalid>()("AuthorSyncStateInvalid", {
    path: Schema.String,
    reason: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `Author sync state at ${this.path} is invalid: ${this.reason}`;
  }
  readonly remediation = "Keep the sync state file and repair or restore it before syncing again.";
}

/** The first-connection checkpoint in .skit/connection.json; its request id is replayed on create. */
export const Connecting = Schema.TaggedStruct("Connecting", {
  remote: AuthorRemoteHome,
  visibility: AuthorVisibility,
  requestId: Schema.String.check(Schema.isMinLength(1)),
});
export type Connecting = typeof Connecting.Type;

/**
 * A connection.json still present beside a valid skit.remote.json (A4). The portable
 * skit.remote.json is the authority, so only a leftover naming the same remote is safe to delete.
 */
const Leftover = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Matching", { checkpoint: Connecting }),
  Schema.TaggedStruct("Mismatched", { checkpoint: Connecting }),
  Schema.TaggedStruct("Invalid", { error: AuthorSyncStateInvalid }),
]);
export type Leftover = typeof Leftover.Type;

/** One logical state over two files: a valid skit.remote.json is Connected whatever else is there. */
const Connection = Schema.Union([
  Schema.TaggedStruct("Unconnected", {}),
  Connecting,
  Schema.TaggedStruct("Connected", { remote: AuthorRemoteHome, leftover: Leftover }),
]);
export type Connection = typeof Connection.Type;
type Connected = Extract<Connection, { _tag: "Connected" }>;

/** One read of all four files. */
const Workspace = Schema.Struct({
  root: WorkspaceRoot,
  identity: Schema.Option(Identity),
  connection: Connection,
});
export type Workspace = typeof Workspace.Type;

/** Which sync checkpoint: workspace identity plus SKIT locator (A5). */
export const SyncKey = Schema.Struct({ workspaceId: WorkspaceId, locator: Schema.String });
export type SyncKey = typeof SyncKey.Type;

/** What the create call proved: this request id created this destination. */
export interface CreateReceipt {
  readonly requestId: string;
  readonly remote: AuthorRemoteHome;
}

/** The connection's one transition: each case is a pair the code really performs. */
export type ConnectionTransition =
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

/** The registration lifecycle's one transition (A2). Only the first case may adopt an id. */
export type RegistrationTransition =
  | {
      readonly from: Extract<Option.Option<Identity>, { _tag: "None" }>;
      readonly to: "IdentityOnly" | "Registered";
      readonly adopt: Option.Option<WorkspaceId>;
    }
  | {
      readonly from: IdentityIn<"IdentityOnly">;
      readonly to: "Registered";
    }
  | {
      readonly from: IdentityIn<"Removed">;
      readonly to: "Registered";
      readonly optIn: true;
    }
  | {
      readonly from: IdentityIn<"IdentityOnly" | "Registered">;
      readonly to: "Removing";
    }
  | {
      readonly from: IdentityIn<"Removing">;
      readonly to: "Removed";
    };

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────

/** What a transition or register planned from is no longer what is on disk. */
export class AuthorWorkspaceConflict
  extends Schema.TaggedError<AuthorWorkspaceConflict>()("AuthorWorkspaceConflict", {
    root: WorkspaceRoot,
    found: Workspace,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `The author workspace at ${this.root} changed while this command was running`;
  }
  readonly remediation = "Run the command again; it plans from what is there now.";
}

/** The input is not an existing directory (A1). */
export class AuthorWorkspaceRootInvalid
  extends Schema.TaggedError<AuthorWorkspaceRootInvalid>()("AuthorWorkspaceRootInvalid", {
    input: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get message() {
    return `${this.input} is not an existing directory`;
  }
  readonly remediation = "Name the author workspace's folder.";
}

/**
 * The lease could not be taken safely: the root no longer realPaths to itself, .skit is not a
 * real directory, or the lock is a symlink, not a regular file, or not a lock SQLite can take.
 */
export class AuthorWorkspaceUnsafe
  extends Schema.TaggedError<AuthorWorkspaceUnsafe>()("AuthorWorkspaceUnsafe", {
    path: Schema.String,
    reason: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `The author workspace cannot be locked safely at ${this.path}: ${this.reason}`;
  }
  readonly remediation =
    "Inspect that path, move anything unexpected aside, then run the command again.";
}

/** Another process (or this one) holds the workspace lease. */
export class AuthorWorkspaceBusy
  extends Schema.TaggedError<AuthorWorkspaceBusy>()("AuthorWorkspaceBusy", { root: WorkspaceRoot })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
  get message() {
    return `Another SKIT command is changing the author workspace at ${this.root}`;
  }
  readonly remediation = "Wait for it to finish, then run the command again.";
}

/** writeTree's trees are not the ones a current, unused PreparedWrite names (A13). */
export class AuthorWriteNotPrepared
  extends Schema.TaggedError<AuthorWriteNotPrepared>()("AuthorWriteNotPrepared", { key: SyncKey })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `Sync tried to write ${this.key.locator} without a current saved checkpoint for that write`;
  }
  readonly remediation = "Sync again; it saves a new checkpoint before writing.";
}

/** A lease handle used after its scope closed. */
export class AuthorLeaseNotHeld
  extends Schema.TaggedError<AuthorLeaseNotHeld>()("AuthorLeaseNotHeld", {
    root: WorkspaceRoot,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `The author workspace lease for ${this.root} is closed`;
  }
  readonly remediation = "Run the command again.";
}

export type WorkspaceReadError =
  | AuthorWorkspaceMetadataInvalid
  | AuthorRemoteMetadataInvalid
  | AuthorSyncStateInvalid
  | PlatformError.PlatformError;

export type WriteTreeError =
  | AuthorWriteNotPrepared
  | LocalFilesChangedDuringSync
  | SkitContractError
  | AuthorLocalPathNotObserved
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
  readonly revision: Effect.Effect<number, AuthorLeaseNotHeld>;
  /** For AuthorHistory only: record a checkpoint step under this hold; returns the new revision. */
  readonly advance: Effect.Effect<number, AuthorLeaseNotHeld>;
  /** The registration lifecycle. Returns the identity now on disk. */
  readonly register: (
    change: RegistrationTransition,
  ) => Effect.Effect<Identity, AuthorWorkspaceConflict | AuthorLeaseNotHeld | WorkspaceReadError>;
  /** The connection lifecycle. Every write is flushed before returning. Returns the new state. */
  readonly transition: (
    change: ConnectionTransition,
  ) => Effect.Effect<Connection, AuthorWorkspaceConflict | AuthorLeaseNotHeld | WorkspaceReadError>;
  /**
   * Make the files `to` if they are still `from`, given the PreparedWrite for exactly these trees.
   * Any attempt uses the PreparedWrite up. Files only; it records no history.
   */
  readonly writeTree: (change: {
    readonly prepared: PreparedWrite;
    readonly from: History.Tree;
    readonly to: History.Tree;
  }) => Effect.Effect<void, WriteTreeError | AuthorLeaseNotHeld>;
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

/** What AuthorWorkspace.layer requires (architecture/author.ts AuthorWorkspaceRequires). */
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
      Effect.map(Option.some),
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

  const readIdentity = Effect.fn("AuthorWorkspace.readIdentity")(function* (root: WorkspaceRoot) {
    const file = identityPath(root);
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isNone(text)) return Option.none<Identity>();
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceDocument), {
      onExcessProperty: "error",
    })(text.value).pipe(Effect.mapError(() => new AuthorWorkspaceMetadataInvalid({ path: file })));
    const registration: Registration =
      document.registration === "registered"
        ? "Registered"
        : document.registration === "removing"
          ? "Removing"
          : document.registration === "removed"
            ? "Removed"
            : "IdentityOnly";
    return Option.some(Identity.make({ workspaceId: document.workspace_id, registration }));
  });

  /** skit.remote.json, canonical or invalid. Any read failure but absence is invalid metadata. */
  const readRemote = Effect.fn("AuthorWorkspace.readRemote")(function* (root: WorkspaceRoot) {
    const file = remotePath(root);
    const invalid = () => new AuthorRemoteMetadataInvalid({ path: file });
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT") ? Effect.succeedNone : Effect.fail(invalid()),
      ),
    );
    if (Option.isNone(text)) return Option.none<AuthorRemoteHome>();
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AuthorRemoteHome), {
      onExcessProperty: "error",
    })(text.value).pipe(Effect.mapError(invalid));
    const normalized = yield* normalizeRemote(document).pipe(
      Effect.catchTags({
        AuthorDestinationInvalid: () => Effect.fail(invalid()),
        AuthorDestinationMalformed: () => Effect.fail(invalid()),
        InsecureOrigin: () => Effect.fail(invalid()),
      }),
    );
    if (!sameRemote(document, normalized)) return yield* invalid();
    return Option.some(normalized);
  });

  /** .skit/connection.json as a Connecting checkpoint, canonical or invalid. */
  const decodeCheckpoint = Effect.fn("AuthorWorkspace.decodeCheckpoint")(function* (
    file: string,
    text: string,
  ) {
    const checkpoint = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Connecting), {
      onExcessProperty: "error",
    })(text).pipe(
      Effect.mapError((error) => new AuthorSyncStateInvalid({ path: file, reason: String(error) })),
    );
    const normalized = yield* normalizeRemote(checkpoint.remote).pipe(
      Effect.mapError((error) => new AuthorSyncStateInvalid({ path: file, reason: String(error) })),
    );
    if (!sameRemote(normalized, checkpoint.remote))
      return yield* new AuthorSyncStateInvalid({ path: file, reason: "Noncanonical destination" });
    return checkpoint;
  });

  const read = Effect.fn("AuthorWorkspace.read")(function* (root: WorkspaceRoot) {
    const identity = yield* readIdentity(root);
    const remote = yield* readRemote(root);
    const file = connectionPath(root);
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
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
        reason: "the folder no longer resolves to itself",
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
        reason: ".skit is not a real directory",
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
        reason: "the lock is not a regular file",
      });
    const lock = yield* Scope.make();
    yield* acquireFileLock(lockPath).pipe(
      Scope.provide(lock),
      Effect.catchTags({
        FileLockBusy: () => Effect.fail(new AuthorWorkspaceBusy({ root })),
        FileLockFailed: (error) =>
          Effect.fail(new AuthorWorkspaceUnsafe({ path: lockPath, reason: String(error.cause) })),
      }),
      Effect.onError(() => Scope.close(lock, Exit.void)),
    );
    return lock;
  });

  const acquire = Effect.fn("AuthorWorkspace.acquire")(function* (root: WorkspaceRoot) {
    const hold = yield* Effect.acquireRelease(
      take(root).pipe(Effect.flatMap((lock) => Ref.make<Hold>({ state: "held", lock }))),
      // Scope close releases only what is still held.
      (ref) =>
        Ref.getAndSet(ref, { state: "closed" }).pipe(
          Effect.flatMap((last) =>
            last.state === "held" ? Scope.close(last.lock, Exit.void) : Effect.void,
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
    // The revision whose PreparedWrite was last presented: each is good for one attempt.
    const presented = yield* Ref.make(-1);
    // Each method runs whole, so a release waits for it rather than cutting it short.
    const permit = yield* Semaphore.make(1);
    const held = Ref.get(hold).pipe(
      Effect.flatMap((current) =>
        current.state === "held" ? Effect.void : Effect.fail(new AuthorLeaseNotHeld({ root })),
      ),
    );

    const register = Effect.fn("AuthorWorkspace.register")(function* (
      change: RegistrationTransition,
    ) {
      yield* held;
      const current = yield* readIdentity(root);
      const from = change.from;
      const planned = Option.isOption(from)
        ? Option.isNone(current)
        : Option.exists(
            current,
            (identity) =>
              identity.workspaceId === from.workspaceId &&
              identity.registration === from.registration,
          );
      if (!planned) return yield* new AuthorWorkspaceConflict({ root, found: yield* read(root) });
      const file = identityPath(root);
      const stored = storedRegistration[change.to];
      if ("adopt" in change) {
        const workspaceId = Option.isSome(change.adopt)
          ? change.adopt.value
          : WorkspaceId.make(`workspace_${(yield* random.uuidV4()).replaceAll("-", "")}`);
        yield* writeJsonExclusive(file, {
          schema: "skit.author-workspace.v1",
          workspace_id: workspaceId,
          ...(stored === undefined ? {} : { registration: stored }),
        });
        yield* syncPaths([file, control(root), root]);
        return Identity.make({ workspaceId, registration: change.to });
      }
      yield* writeJsonAtomic(file, {
        schema: "skit.author-workspace.v1",
        workspace_id: change.from.workspaceId,
        registration: stored,
      });
      yield* syncPaths([file, control(root), root]);
      return Identity.make({ workspaceId: change.from.workspaceId, registration: change.to });
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
      readonly prepared: PreparedWrite;
      readonly from: History.Tree;
      readonly to: History.Tree;
    }) {
      yield* held;
      const { prepared } = change;
      const notPrepared = new AuthorWriteNotPrepared({ key: prepared.key });
      const current = yield* Ref.get(revision);
      if (prepared.ownerId !== ownerId || prepared.revision !== current) return yield* notPrepared;
      // This is the current hold's PreparedWrite: any attempt, failed or partial, uses it up.
      if ((yield* Ref.getAndSet(presented, current)) === current) return yield* notPrepared;
      const identity = yield* readIdentity(root).pipe(
        Effect.catchTag("AuthorWorkspaceMetadataInvalid", () => Effect.fail(notPrepared)),
      );
      if (!Option.exists(identity, (value) => value.workspaceId === prepared.key.workspaceId))
        return yield* notPrepared;
      const hashes = yield* Effect.all([
        History.treeHash(change.from),
        History.treeHash(change.to),
      ]);
      if (hashes[0] !== prepared.from || hashes[1] !== prepared.to) return yield* notPrepared;
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
    read,
    readIdentity,
    acquire: (root) => acquire(root).pipe(Effect.provide(context)),
  };
  return service;
});

export class AuthorWorkspace extends Context.Service<AuthorWorkspace, AuthorWorkspaceShape>()(
  "skit/author/AuthorWorkspace",
) {
  static readonly layer = Layer.effect(AuthorWorkspace, make);
}
