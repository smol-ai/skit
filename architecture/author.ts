/**
 * Architecture contract: the two device-side author owners, AuthorWorkspace and AuthorHistory.
 * Target API, types only. Approved. Both owners are enforced by conformance/author.ts. Same shape
 * as library.ts.
 *
 * Markers: FROM CODE = today's behaviour, cited at its file:line. NEW = not in today's code.
 * OPEN: = a choice the code does not settle; each names its entry in decisions.md "Author owners" (A1…).
 * OPEN-FOR-TIM: = a product choice waiting on Tim; the contract around it holds for every option.
 * Paths below are relative to packages/cli/src unless they start with packages/ or docs/.
 *
 * Never shipped: no author command is wired into commands/tree.ts, so no saved author state needs
 * migrating. Old formats fail with a clear error at the owner's loader (decided; A5).
 *
 * ── What this replaces or removes ───────────────────────────────────────────────────────────────
 * AuthorWorkspace (owns <root>/.skit/workspace.json, .skit/.gitignore, .skit/connection.json,
 * .skit/lock, .skit/stage-*, <root>/skit.remote.json, and workspace file writes during sync):
 *   - loadAuthorRemote, loadAuthorConnection, loadAuthorSyncRemote: three loaders for one state
 *     (workflows/author/sync.ts:200-233, :253-281, :284-286) → AuthorWorkspace.read
 *   - saveAuthorConnection, removeAuthorConnection, writeRemote: three writers for one state
 *     (sync.ts:288-311) → WorkspaceLease.transition
 *   - writeAuthorTree (sync.ts:381-449) → WorkspaceLease.writeTree; its refreshAuthorHistory call
 *     (sync.ts:388) moves to the sync workflow's write callback
 *   - writeAuthorTree's staging in the global temp dir (sync.ts:417, then rename :427: EXDEV across
 *     filesystems) and its unflushed renames/removes (sync.ts:421-434) → staged under .skit/, fsynced (A13)
 *   - scanAuthorSyncTree's exported checkTarget (workflows/author/local-tree.ts:60-181) → private to
 *     writeTree; the scan itself stays a plain function (SyncScan below)
 *   - LinkStat.removeEmptyDirectory (sync.ts:437-448; its only caller) → private to writeTree
 *   - writeAuthorWorkspace, prepareAuthorWorkspaceMetadata, markAuthorWorkspaceRemoved
 *     (library/author-workspace.ts:31-37, :108-126, :169-184) → WorkspaceLease.register
 *   - loadAuthorWorkspaceMetadata as a public reader (library/author-workspace-metadata.ts:20-32;
 *     also read by workflows/author/history.ts:117 and history-journal.ts:48) → AuthorWorkspace.read
 *     and AuthorWorkspace.readIdentity
 *   - ensureAuthorWorkspaceIdentity (workflows/author/workspace-identity.ts:16-41) and
 *     ensureAuthorWorkspaceRegistered (library/author-workspace.ts:155-166): become the plain
 *     `author init` / `author sync` workflows composing register + Library.import.authored; no
 *     withLibraryWriter, no LibraryStore, no localLibrary (author-workspace.ts:138, :160, :166;
 *     workspace-identity.ts:22-23)
 *   - node:crypto randomUUID for workspace ids and request ids (author-workspace.ts:87; sync.ts:613)
 *     → SecureRandom inside the owner
 * AuthorHistory (owns <home>/history/{trees,revisions}/**, <home>/history/journal.sqlite*, and
 * <home>/sync-bindings.json):
 *   - refreshAuthorHistory (workflows/author/history.ts:72-166) → AuthorHistory.capture
 *   - historyDirectory, withDeviceStore as exports (history.ts:12-15; device-store.ts:90-107):
 *     removed. Owner methods (capture, retain) plus the narrow engineStore adapter (A7); no
 *     general "run anything against the store" entry point. layerDeviceStore stays private
 *     (device-store.ts:18-84)
 *   - loadSyncStates, saveSyncState (sync.ts:317-374) → AuthorHistory.syncState.{read, transition}
 *   - Branch-only bindings formats were discarded before release; current bindings start at v1.
 *     and PreReleaseBindings (sync.ts:98-111, :331-335): removed. Any of them now fails
 *     AuthorSyncStateInvalid at the loader; no migration, no back-compat (decided; A5)
 *   - module-global journal semaphore `writers` (history-journal.ts:29) → held by the layer (A9)
 *   - MachineSettings.read / ensureIdentity called from history (history.ts:123-128)
 *     → MachineSettings.identity (D3); the "never take the Library writer" ordering note goes away
 *   - loadAuthorHistory, loadStoredTrees, loadAuthorTree (history.ts:17-64): only tests call them
 *     (packages/cli/test/**). Removed; tests never justify code.
 * Core sync engine (packages/skit/src/sync/sync.ts):
 *   - NEW: Sync.Remote as a Context.Service (sync.ts:95-124) → a plain `remote` input to
 *     Sync.loadPlanInput / Sync.run (SyncRemote below). It owns no state and holds no resource;
 *     the CLI already builds one per command from the Registry client (workflows/author/sync.ts:517-590).
 * Handlers (handlers/author/*.ts):
 *   - resolveAuth / resolveAuthForOrigin calls (handlers/author/sync.ts:35, :41, :98;
 *     handlers/author/publish.ts:39; workflows/author/list.ts:197; delete.ts:141, :166)
 *     → Registry.credentials (app.ts owners.Registry)
 *   - the handler's own loadAuthorSyncRemote read (handlers/author/sync.ts:33) and publish's
 *     requireRegistryBinding (handlers/author/publish.ts:19-26): the workflow reads once
 */
import type { Brand, Effect, FileSystem, Layer, Option, Path, PlatformError, Scope } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";
import type * as History from "../packages/skit/src/history/history.js";
import type * as Sync from "../packages/skit/src/sync/sync.js";
import type { LinkStat } from "../packages/skit/src/platform/link-stat.js";
import type { SourceProcess } from "../packages/skit/src/platform/source-process.js";
import type { AuthorIgnoreRepository } from "../packages/skit/src/artifact/plain-author-ignore.js";
import type { TreeError } from "../packages/skit/src/shared/tree-error.js";
import type { SkitContractError } from "../packages/skit/src/api/contracts.js";
import type { Unusable as MachineSettingsUnusable } from "../packages/skit/src/library/machine-settings.js";
import type {
  AuthorRemoteHome,
  AuthorSyncStateInvalid,
  AuthorVisibility,
  AuthorHistoryBusy,
  AuthorHistoryInvalid,
  AuthorSyncStateConflict,
  AuthorBackupStateConflict,
  AuthorSyncStateIllegal,
  AuthorLocalPathNotObserved,
  AuthorNonNfcPathUnsupported,
  AuthorNormalizationTwin,
  AuthorRemoteMetadataInvalid,
  LocalFilesChangedDuringSync,
  AuthorWorkspaceAlreadyRegistered,
  AuthorWorkspaceMetadataInvalid,
  AuthorLeaseNotHeld,
  AuthorWorkspaceBusy,
  AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
  AuthorWorkspaceUnsafe,
  AuthorWriteNotPrepared,
} from "../packages/skit/src/author/index.js";

// The NEW errors below, bound to their Schema.TaggedError classes (decisions.md "Errors"); each
// keeps the fields stated here.

export type {
  AuthorLeaseNotHeld,
  AuthorSyncStateConflict,
  AuthorBackupStateConflict,
  AuthorSyncStateIllegal,
  AuthorWorkspaceBusy,
  AuthorWorkspaceConflict,
  AuthorWorkspaceUnsafe,
  AuthorWriteNotPrepared,
};

// ── Shared vocabulary ──────────────────────────────────────────────────────────────────────────

/**
 * NEW brand, minted only by AuthorWorkspace.resolveRoot (A1): realPath(resolve(input)) of an existing
 * directory (today history.ts:79; workspace-identity.ts:21). Journal rows store roots that were
 * WorkspaceRoots when written, so AuthorHistory decodes them as such.
 */
export type WorkspaceRoot = Brand.Branded<string, "WorkspaceRoot">;

/** FROM CODE: `workspace_<32 hex>` (library/author-workspace-metadata.ts:11). Device-local, never portable (ADR-0026:9-10). */
export type WorkspaceId = Brand.Branded<string, "WorkspaceId">;

/** FROM CODE: skit.remote.v1, origin + namespace + skit, normalized (sync.ts:115-121, :142-155). ADR-0010/0011 contract, unchanged. */
export type RemoteHome = AuthorRemoteHome;

/** FROM CODE: `skit://<authority>/<namespace>/<skit>` (sync.ts:195-198). */
export type Locator = string;

/** Shared contention error: every home owner competes for the same OS lock. */
export type { HomeBusy } from "../packages/skit/src/platform/lock-failures.js";
import type { HomeBusy } from "../packages/skit/src/platform/lock-failures.js";

/**
 * NEW (core change): the Registry side of one SKIT, a plain value passed to Sync.loadPlanInput and
 * Sync.run instead of the Sync.Remote Context.Service (packages/skit/src/sync/sync.ts:95-124). Same
 * methods; Sync.Remote is now that interface. Built by the sync workflow from the authoring client
 * (workflows/author/sync.ts:517-590).
 */
export type SyncRemote = Sync.Remote;

// ── AuthorWorkspace: state ─────────────────────────────────────────────────────────────────────

/**
 * FROM CODE: the `registration` key of .skit/workspace.json (author-workspace-metadata.ts:12).
 * Backup and installation are separate facts (ADR-0026:33-38):
 *   - any Identity can be backed up and synced (its workspaceId keys history and SyncKey);
 *   - only "Registered" is registered for installation: Library promotion may import it.
 * "IdentityOnly" = the key is absent: identity without opt-in to installation. Sync creates it; an
 *   interrupted `author init` also leaves it (author-workspace.ts:113 ran, :151 did not), which is
 *   safe: backup works, installation waits for init to run again.
 * "Removing" = NEW durable removal intent, written before Library.apply (A15). Reads as Removed for
 *   promotion. "Removed" = the opt-out marker; nothing automatic resurrects it (ADR-0026:33-35).
 */
export type Registration = "IdentityOnly" | "Registered" | "Removing" | "Removed";

/** FROM CODE: .skit/workspace.json, skit.author-workspace.v1 (author-workspace-metadata.ts:8-14). NEW: "removing" value. */
export interface Identity {
  readonly workspaceId: WorkspaceId;
  readonly registration: Registration;
}
type IdentityIn<R extends Registration> = Identity & { readonly registration: R };

/** FROM CODE: the Connecting checkpoint in .skit/connection.json (sync.ts:241-245, :251). */
export interface Connecting {
  readonly _tag: "Connecting";
  readonly remote: RemoteHome;
  readonly visibility: AuthorVisibility;
  readonly requestId: string; // replayed as request_id on create (sync.ts:617); minted by the owner (NEW, was randomUUID sync.ts:613)
}

/**
 * NEW: what the create call proved (sync.ts:615-629): this request id created this destination.
 * Built by the workflow from the create response. First connection needs one (A4).
 */
export interface CreateReceipt {
  readonly requestId: string;
  readonly remote: RemoteHome;
}

/**
 * NEW (A4): a .skit/connection.json still present beside a valid skit.remote.json, left by a crash
 * between writeRemote and removeAuthorConnection (sync.ts:632-633). Today it is ignored forever
 * (sync.ts:254-255). The portable skit.remote.json is the authority (ADR-0010:13, ADR-0011:5), so
 * only a leftover naming the same remote is safe to delete; anything else stops sync and is reported.
 */
export type Leftover =
  | { readonly _tag: "None" }
  | { readonly _tag: "Matching"; readonly checkpoint: Connecting }
  | { readonly _tag: "Mismatched"; readonly checkpoint: Connecting }
  | { readonly _tag: "Invalid"; readonly error: AuthorSyncStateInvalid };

/**
 * The connection: ONE logical state over two files (decided). Precedence FROM CODE
 * (sync.ts:254-255): a valid skit.remote.json is Connected whatever connection.json says.
 * NewRemote (sync.ts:237-240, :483-486) is not persisted: it is the sync command's flags, so it
 * stays in the workflow and never comes back from read.
 */
export type Connection =
  | { readonly _tag: "Unconnected" } // FROM CODE: loadAuthorConnection → undefined (sync.ts:265)
  | Connecting
  | {
      readonly _tag: "Connected"; // FROM CODE: ConnectedRemote (sync.ts:246)
      readonly remote: RemoteHome;
      readonly leftover: Leftover;
    };
type Connected = Extract<Connection, { _tag: "Connected" }>;

/** One read of all four files. */
export interface Workspace {
  readonly root: WorkspaceRoot;
  /** None when .skit/workspace.json is absent (author-workspace-metadata.ts:27). */
  readonly identity: Option.Option<Identity>;
  readonly connection: Connection;
}

// ── AuthorWorkspace: transitions ───────────────────────────────────────────────────────────────

/**
 * The connection's one transition. Each case is a pair the code really performs; any other pair is
 * unrepresentable. The owner re-reads under the lease and fails AuthorWorkspaceConflict unless the
 * connection still equals `from` (D1-style check, here by value: the state is tiny and carries a
 * requestId, so equal values mean the same checkpoint).
 */
export type ConnectionTransition =
  | {
      // FROM CODE: saveAuthorConnection, exclusive create + fsync before any network call (sync.ts:288-296, :614)
      readonly from: Extract<Connection, { _tag: "Unconnected" }>;
      readonly to: {
        readonly _tag: "Connecting";
        readonly remote: RemoteHome;
        readonly visibility: AuthorVisibility;
      };
    }
  | {
      // FROM CODE: a definitive receipt mismatch abandons the checkpoint (sync.ts:625-628)
      readonly from: Connecting;
      readonly to: { readonly _tag: "Unconnected" };
    }
  | {
      // FROM CODE: writeRemote then removeAuthorConnection (sync.ts:632-633). NEW: refused unless
      // receipt.requestId and receipt.remote equal `from`'s (A4).
      readonly from: Connecting;
      readonly to: { readonly _tag: "Connected" };
      readonly receipt: CreateReceipt;
    }
  | {
      // NEW (A4): delete a leftover that names the connected remote. Touches only connection.json;
      // never the sync checkpoint. There is no Connected → Connected without a Matching leftover.
      readonly from: Connected & { readonly leftover: Extract<Leftover, { _tag: "Matching" }> };
      readonly to: { readonly _tag: "Connected" };
    };

/**
 * The registration lifecycle's one transition (A2). The owner re-reads under the lease and fails
 * AuthorWorkspaceConflict unless the identity on disk equals `from` by value (id and registration), so
 * an id is never replaced. Content goes through Library.import.authored, called by the workflow.
 */
export type RegistrationTransition =
  | {
      // Create the identity and .skit/.gitignore (ADR-0026:24-27). `to: "IdentityOnly"` is sync's
      // identity-only registration (backup, no installation); `to: "Registered"` is `author init`.
      readonly from: Extract<Option.Option<Identity>, { _tag: "None" }>;
      readonly to: "IdentityOnly" | "Registered";
      /**
       * FROM CODE: reuse the workspace id an existing authored Library collection already names when
       * workspace.json is missing (author-workspace.ts:68-72, :84-86). Only from None: an existing id
       * is never replaced. The workflow finds it with Library.read (A3); AuthorWorkspace does not
       * require Library.
       */
      readonly adopt: Option.Option<WorkspaceId>;
    }
  | {
      // `author init` on an identity-only workspace (FROM CODE: author-workspace.ts:151).
      readonly from: IdentityIn<"IdentityOnly">;
      readonly to: "Registered";
    }
  | {
      // FROM CODE: an explicit opt-in re-registers a removed workspace (workspace-identity.ts:26,
      // `register` option). Never automatic (ADR-0026:33-35).
      readonly from: IdentityIn<"Removed">;
      readonly to: "Registered";
      readonly optIn: true;
    }
  | {
      // NEW (A15): durable removal intent, written before Library.apply removes the collection.
      readonly from: IdentityIn<"IdentityOnly" | "Registered">;
      readonly to: "Removing";
    }
  | {
      // FROM CODE: markAuthorWorkspaceRemoved after Library removes the collection
      // (author-workspace.ts:169-184; called from workflows/library/remove.ts:81)
      readonly from: IdentityIn<"Removing">;
      readonly to: "Removed";
    };

// NEW: AuthorWorkspaceConflict { root: WorkspaceRoot; found: Workspace }: what a transition or
//   register planned from is no longer what is on disk.
// NEW (A1): AuthorWorkspaceRootInvalid { input }: the input is not an existing directory.
export type WorkspaceRootInvalid = AuthorWorkspaceRootInvalid;
// NEW (A8): AuthorWorkspaceUnsafe { path; reason }: the lease could not be taken safely: the root
//   no longer realPaths to itself, .skit is not a real directory, or .skit/lock.sqlite is a
//   symlink, not a regular file, or not a lock SQLite can take.
// NEW: AuthorWorkspaceBusy { root: WorkspaceRoot }: another process (or this one) holds the
//   workspace lease. Retryable.
// NEW (A13): AuthorWriteNotPrepared { key: SyncKey }: writeTree's trees are not the ones the
//   prepared checkpoint names.

export type WorkspaceReadError =
  | AuthorWorkspaceMetadataInvalid // workspace.json (author-workspace-metadata.ts:30)
  | AuthorRemoteMetadataInvalid // skit.remote.json (sync.ts:211, :216-230)
  | AuthorSyncStateInvalid // connection.json while not Connected (sync.ts:266-279); Connected reports Leftover.Invalid instead
  | PlatformError.PlatformError;

/** Everything writeTree refuses, FROM CODE sync.ts:390-406 and local-tree.ts:60-180. */
export type WriteTreeError =
  | AuthorWriteNotPrepared
  | LocalFilesChangedDuringSync // files are no longer `from` (sync.ts:390-391; local-tree.ts:115, :119, :148, :172)
  | SkitContractError // `to` holds a directory/symlink (sync.ts:396-406), or a non-canonical target (local-tree.ts:67)
  | AuthorLocalPathNotObserved // local-tree.ts:110, :139, :143
  | AuthorNormalizationTwin // local-tree.ts:106, :132
  | AuthorNonNfcPathUnsupported // local-tree.ts:124
  | TreeError // scanAuthorTree (local-tree.ts:28-34)
  | PlatformError.PlatformError; // includes EXDEV when a target sits on another mount: reported, never copied around

/**
 * FROM CODE scanAuthorSyncTree (local-tree.ts:24-181), a plain function, not owner state.
 * NEW: it also reports the verbatim tree hash of the snapshot it normalized, so the sync workflow
 * can check it against Observation.treeHash (A14). checkTarget becomes private to writeTree.
 */
export interface SyncScan {
  readonly tree: History.Tree;
  readonly verbatimHash: History.TreeHash;
}

// ── AuthorWorkspace: surface ───────────────────────────────────────────────────────────────────

/**
 * NEW (A8): the exclusive per-workspace lease, across processes (ADR-0026:228-236). Every write to
 * this workspace goes through it: register, transition, writeTree here, and the plain built-in
 * edits (`author init`'s scaffold, `author invocation`) take the handle as evidence (A11).
 * Valid only inside the scope that acquired it; not reentrant (a second acquire of the same root,
 * in this process or another, fails AuthorWorkspaceBusy rather than deadlocking).
 * Lock order: workspace lease, then the short home lock (syncState.save), then the Library
 * writer. Never the reverse; only the lease is held across network calls.
 */
export interface WorkspaceLease {
  readonly root: WorkspaceRoot;
  /**
   * NEW: `ownerId` is a fresh random id per hold of the lease (t3code serverOwnership.ts#L188
   * `ownerId`). `revision` changes on every checkpoint step for this workspace (AuthorHistory's
   * syncState.save / prepareWrite call `advance` with this handle), so every outstanding
   * PreparedWrite goes stale ("Reject unless the captured
   * revision is still current", yielded-auth AuthenticationAuthority.ts#L33). AuthorWorkspace never
   * reads the checkpoint.
   */
  readonly ownerId: string;
  readonly revision: Effect.Effect<number, AuthorLeaseNotHeld>;
  /** For AuthorHistory only: record a checkpoint step under this hold; returns the new revision. */
  readonly advance: Effect.Effect<number, AuthorLeaseNotHeld>;
  /** The registration lifecycle. Returns the identity now on disk. */
  readonly register: (
    change: RegistrationTransition,
  ) => Effect.Effect<Identity, AuthorWorkspaceConflict | AuthorLeaseNotHeld | WorkspaceReadError>;
  /**
   * The connection lifecycle. Every write is flushed with its directory entries before returning
   * (sync.ts:295, :301, :310), so a caller may talk to the Registry right after. Returns the new state.
   */
  readonly transition: (
    change: ConnectionTransition,
  ) => Effect.Effect<Connection, AuthorWorkspaceConflict | AuthorLeaseNotHeld | WorkspaceReadError>;
  /**
   * FROM CODE writeAuthorTree (sync.ts:381-449): make the files `to` if they are still `from`.
   * NEW (A13): takes the PreparedWrite AuthorHistory returned when it saved the Writing checkpoint
   * for exactly these trees, so a write without a durable checkpoint is unrepresentable. Refuses
   * AuthorWriteNotPrepared unless hash(from) and hash(to) equal it, its ownerId is this
   * lease's and its revision is current (no checkpoint step or retake since), its key's workspaceId is
   * this workspace's, and it has not been used. Any attempt uses it up, a failed or partial one
   * too, so recovery must prepareWrite again (t3code guards status AND lease owner at the moment
   * of the write: EffectOutbox.ts#L586-L642).
   * Rescans and refuses unless the tree hash equals `from`'s (sync.ts:389-391); checks every target
   * before writing any (sync.ts:414) and again just before each mutation (local-tree.ts:145-172).
   * That check is not atomic against an external editor: an editor save racing a rename can be
   * overwritten (a limitation, A11). NEW: stages under <root>/.skit/stage-* (same filesystem as the
   * targets, git-ignored), fsyncs every written file and every directory whose entries changed
   * (renamed-into, removed-from, removed folders' parents) before returning; leftover stage folders
   * are removed at the next acquire. Files only. It does not record history: the workflow captures first.
   */
  readonly writeTree: (change: {
    readonly prepared: PreparedWrite;
    readonly from: History.Tree;
    readonly to: History.Tree;
  }) => Effect.Effect<void, WriteTreeError | AuthorLeaseNotHeld>;
  // REMOVED (Tim, 2026-11-04): withLeaseReleased. Sync never retries, so nothing would call it;
  // the lease is held for the whole command. Re-add it, with ADR-0026:233-236's release during
  // retry sleeps, only when a retry schedule exists.
}

// NEW: AuthorLeaseNotHeld { root: WorkspaceRoot }: a lease handle used after its scope closed.

/**
 * One service per process; every method takes the root (A1). Holds state (four files) and a
 * resource (the per-workspace leases), so it is a Context.Service.
 */
export interface AuthorWorkspace {
  /** NEW (A1): the only way to mint a WorkspaceRoot (as Effect Path.resolve, plus realPath). */
  readonly resolveRoot: (
    input: string,
  ) => Effect.Effect<WorkspaceRoot, WorkspaceRootInvalid | PlatformError.PlatformError>;
  /** One read of identity and connection. Never writes (D2), so preview needs no lease. */
  readonly read: (root: WorkspaceRoot) => Effect.Effect<Workspace, WorkspaceReadError>;
  /**
   * NEW (A10): identity only, reading only .skit/workspace.json; never the connection files. For
   * AuthorHistory. Absent file → None (also when the root itself is gone). It fails only on a
   * malformed file or I/O, so the caller can tell "no identity" from "broken identity".
   */
  readonly readIdentity: (
    root: WorkspaceRoot,
  ) => Effect.Effect<
    Option.Option<Identity>,
    AuthorWorkspaceMetadataInvalid | PlatformError.PlatformError
  >;
  /**
   * NEW (A8): take the lease until the scope closes. Non-blocking: fails AuthorWorkspaceBusy at once.
   * Checks realPath(root) === root, creates .skit/ (0700) and .skit/.gitignore (`*`) if absent,
   * refuses a .skit that is not a real directory, checks .skit/lock.sqlite is absent or a regular
   * file (no-follow), then holds an exclusive SQLite transaction on it (`PRAGMA busy_timeout = 0;
   * BEGIN EXCLUSIVE`; busy → AuthorWorkspaceBusy) through acquireFileLock. The file never holds
   * data and is never unlinked; the OS releases the lock when the process exits, even on SIGKILL
   * (t3code serverOwnership.ts#L177-L208). Only applying commands acquire it; previews and reads
   * never create .skit or the lock.
   */
  readonly acquire: (
    root: WorkspaceRoot,
  ) => Effect.Effect<
    WorkspaceLease,
    AuthorWorkspaceBusy | AuthorWorkspaceUnsafe | PlatformError.PlatformError,
    Scope.Scope
  >;
}

/** AuthorWorkspace.layer takes no config: roots are per call (A1). */
export type AuthorWorkspaceConfig = Record<never, never>;
export type AuthorWorkspaceLayerError = never;

/** What AuthorWorkspace.layer may require. No Library, no AuthorHistory, no Registry, no home lock. */
export type AuthorWorkspaceRequires =
  | FileSystem.FileSystem
  | Path.Path
  | LinkStat // lstat / realPathNative in the target check (local-tree.ts:47-59); lock-path checks
  | SourceProcess // scanAuthorTree (packages/skit/src/platform/tree-requirements.ts:5)
  | AuthorIgnoreRepository // scanAuthorTree (packages/skit/src/artifact/tree.ts:258)
  | Digest.Digest // History.treeHash (sync.ts:390)
  | SecureRandom.SecureRandom; // workspace id and request id (NEW, replaces node:crypto)
// The lease lock is the plain function acquireFileLock (packages/skit/src/platform/
// file-lock.ts), not a service: like t3code's acquireServerOwnership it owns no state and
// has one implementation. FileLockBusy maps to AuthorWorkspaceBusy.

export type AuthorWorkspaceLayer = Layer.Layer<
  Services.AuthorWorkspace,
  AuthorWorkspaceLayerError,
  AuthorWorkspaceRequires
>;

// ── AuthorHistory: state ───────────────────────────────────────────────────────────────────────

/**
 * FROM CODE: what refreshAuthorHistory's callers use: `id` (workspace-identity.ts:37) and
 * `revision.author` (sync.ts:670). NEW (A14): `treeHash`, the verbatim hash of the tree this
 * revision records (history.ts:134), so sync can prove its own scan saw the same files. Its other
 * fields (tree, root, workspace_id; history.ts:161-165) have no production reader and are dropped.
 */
export interface Observation {
  readonly id: History.RevisionId;
  readonly revision: History.Revision;
  readonly treeHash: History.TreeHash;
}

/**
 * Which sync checkpoint (decided, A5): workspace identity plus SKIT locator, so two clones on one
 * device never share one. Was locator only (sync.ts:93-96, :348).
 * File format NEW: { schema: "skit.sync-bindings.v1", workspaces: { [WorkspaceId]: { [Locator]:
 * SyncState } } }. v3 and older fail AuthorSyncStateInvalid naming the file and saying it was
 * written by an unreleased build; no migration (author commands never shipped).
 */
export interface SyncKey {
  readonly workspaceId: WorkspaceId;
  readonly locator: Locator;
}

/**
 * NEW (A13): proof minted only by AuthorHistory.syncState.save when it durably saved a
 * Writing checkpoint and checked both trees are in the store. writeTree requires it.
 */
export type PreparedWrite = Brand.Branded<
  {
    readonly key: SyncKey;
    readonly from: History.TreeHash;
    readonly to: History.TreeHash;
    readonly ownerId: string; // the lease hold it was prepared under
    readonly revision: number; // the lease revision it was prepared at
  },
  "PreparedWrite"
>;

// NEW: AuthorSyncStateConflict { key: SyncKey; found: Sync.SyncState }: the saved checkpoint is
//   no longer the one the step planned from.
// NEW (A6): AuthorSyncStateIllegal { key: SyncKey; from; to: Sync.SyncState }: `from → to` is not a
//   step the engine's policy allows (pure check in core Sync: Sync.allowsStep).

export type CaptureError =
  | AuthorHistoryInvalid // history inside its workspace, journal symlink, store unreadable (history.ts:87-114; device-store.ts:95-105)
  | AuthorHistoryBusy // SQLite contention after retries (history-journal.ts:197-205)
  | LocalFilesChangedDuringSync // no stable scan after 2 retries (history.ts:132-141)
  | AuthorWorkspaceAlreadyRegistered // a live copy of this workspace id elsewhere (history-journal.ts:47-53)
  | HomeBusy // MachineSettings identity creation takes the shared home lock.
  | MachineSettingsUnusable // OPEN: becomes MachineSettings' error (D3); today history.ts:125-126, :152
  | TreeError
  | PlatformError.PlatformError; // includes AuthorWorkspace.readIdentity's I/O errors; only a malformed workspace.json falls back

export type SyncStateError = AuthorSyncStateInvalid | PlatformError.PlatformError;

// ── AuthorHistory: surface ─────────────────────────────────────────────────────────────────────

/**
 * Holds state (history store, journal, sync checkpoints) and a resource (the journal writer
 * permit), so it is a Context.Service. It does not run sync: the plain sync workflow drives
 * Sync.plan / Sync.run with this owner's engineStore and checkpoint transition (A7).
 */
export interface AuthorHistory {
  /**
   * FROM CODE refreshAuthorHistory (history.ts:72-166): scan the workspace verbatim until stable,
   * store its tree, record a revision when the tree changed (author = MachineSettings identity +
   * Clock), append a journal event in one SQLite transaction, then flush directories. An unchanged
   * scan returns the latest revision and records nothing. NEW (A10): reads the workspace id through
   * AuthorWorkspace.readIdentity (this root, and an older root for the copy check, history-journal.ts:48);
   * only AuthorWorkspaceMetadataInvalid falls back to path provenance (history.ts:115-119), every
   * other failure propagates. Needs no lease: it writes only home state.
   */
  readonly capture: (root: WorkspaceRoot) => Effect.Effect<Observation, CaptureError>;
  /** NEW (A7): store a tree (immutable, content-addressed, idempotent). Replaces withStore(putTree) at sync.ts:511-515. */
  readonly retain: (tree: History.Tree) => Effect.Effect<History.TreeHash, AuthorHistoryInvalid>;
  /**
   * NEW (A7): the History.Store adapter the sync engine runs against, over <home>/history: a plain
   * value the sync workflow passes to Sync.loadPlanInput and Sync.run (History.Store is an interface,
   * not a Context.Service; packages/skit/src/history/history.ts). Approved storage port: its only
   * writes (putTree, commit) are immutable, content-addressed and idempotent (device-store.ts:32-66);
   * it never touches the journal or sync-bindings.json. The workflow maps its StoreError to
   * AuthorHistoryInvalid as device-store.ts:95-105 does today.
   */
  readonly engineStore: History.Store;
  /** Acknowledged chronological observations, separate from current remote content (ADR-0025). */
  readonly backupState: {
    /** Absent reads as null without creating storage; old v4 documents have no acknowledgement. */
    readonly read: (key: SyncKey) => Effect.Effect<History.RevisionId | null, SyncStateError>;
    /**
     * Save after remote acceptance, under the workspace lease and home lock. Refuse stale `from`,
     * missing/corrupt local revision or tree, and skipped observation parents. Flush before return,
     * then advance the lease. Other workspaces, remotes and syncState entries stay unchanged.
     * First-connection reset clears only this destination's backup checkpoint.
     */
    readonly save: (
      lease: WorkspaceLease,
      key: SyncKey,
      change: { readonly from: History.RevisionId | null; readonly to: History.RevisionId },
    ) => Effect.Effect<
      void,
      | AuthorBackupStateConflict
      | AuthorHistoryInvalid
      | AuthorLeaseNotHeld
      | HomeBusy
      | SyncStateError
    >;
  };
  /** The sync checkpoint, Idle | Sending | Writing (packages/skit/src/sync/sync.ts:26-39). One read, one transition. */
  readonly syncState: {
    /** FROM CODE: absent reads as Idle { base: null } (sync.ts:636-638). Never writes. */
    readonly read: (key: SyncKey) => Effect.Effect<Sync.SyncState, SyncStateError>;
    /**
     * FROM CODE saveSyncState (sync.ts:339-374): flushed, then renamed over the old file.
     * NEW (A6): under the home lock for the whole read-modify-write; refuses AuthorSyncStateConflict
     * unless the saved entry for `key` still equals `from`; rewrites only that entry and keeps every
     * other entry byte-for-byte as decoded; refuses AuthorSyncStateIllegal unless the engine allows the step.
     * `reset` (NEW, A4) is the only way back to Idle { base: null } from another state: the first
     * connection, proven by a CreateReceipt (was sync.ts:631). Leftover cleanup never resets.
     * Every step except into Writing; that one is prepareWrite.
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
      | HomeBusy
      | SyncStateError
    >;
    /**
     * NEW (A13): the step into Writing, with transition's checks, after checking both trees are in
     * the store (missing, unreadable, wrong-hash or impossible path namespaces are AuthorHistoryInvalid). Returns the
     * PreparedWrite that lease.writeTree requires, bound to the lease's ownerId and new revision. One method
     * per kind of step, as t3code's outbox has one compare-and-set per transition
     * (EffectOutbox.ts#L586-L637). Both methods call lease.advance after saving, under the home lock.
     */
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
      | HomeBusy
      | SyncStateError
    >;
  };
}

/**
 * AuthorHistory.layer({ home }). Paths FROM CODE: <home>/history (history.ts:12-15) and
 * <home>/sync-bindings.json (configuration/skit-configuration.ts:30). The layer creates the
 * journal writer permit (A9) and nothing on disk: a read never creates the journal
 * (history-journal.ts:213-221). Journal schema v0 → v1 is creation, not migration
 * (history-journal.ts:100-116); an unknown version is AuthorHistoryInvalid (:91-98).
 * The app builds one layer per home and shares it, so one permit guards each home in a process (A9).
 *
 * Composition (NEW): Effect builds a layer value once per graph (Layer Memoization guide), not
 * once per equal config, so the CLI names one `authorLayer(home)` per runtime: AuthorHistory over
 * AuthorWorkspace, built once. Every operation in
 * that runtime uses that instance; separate processes rely on the workspace lock and the home lock
 * (t3code names and reuses its shared subgraphs: runtimeLayer.ts#L60-L103).
 */
export interface AuthorHistoryConfig {
  readonly home: string;
}
export type AuthorHistoryLayerError = never;

/** Stand-ins for service tags; a conformance file binds them to the real ones. */
export declare namespace Services {
  interface AuthorWorkspace {
    readonly _contract: "skit/author/AuthorWorkspace";
  }
  interface AuthorHistory {
    readonly _contract: "skit/author/AuthorHistory";
  }
}
// MachineSettings (D3, packages/skit/src/library/machine-settings.ts) and the home lock are plain
// functions, not services, so they are not layer requirements: AuthorHistory calls
// MachineSettings.read / ensureIdentity for the revision author device (history.ts:123-128) and
// takes the home lock around the sync-bindings.json read-modify-write (A6). The home lock is a
// plain Effect.fn as t3code's directory lock is (serverOwnership.ts#L183); today that is
// HomeLock.withLock (packages/skit/src/platform/home-lock.ts).

/** What AuthorHistory.layer may require. Not Library, not Registry. */
export type AuthorHistoryRequires =
  | FileSystem.FileSystem
  | Path.Path
  | LinkStat // journal symlink check (history.ts:105-114)
  | SourceProcess // walkAuthorTree (history.ts:133)
  | AuthorIgnoreRepository // walkAuthorTree (packages/skit/src/artifact/tree.ts:258)
  | Digest.Digest // History.makeStore, treeHash (device-store.ts:25; history.ts:134)
  | SecureRandom.SecureRandom // journal workspace keys (history-journal.ts:84)
  | Services.AuthorWorkspace; // identity only (A10): history.ts:117; history-journal.ts:48

export type AuthorHistoryLayer = (
  config: AuthorHistoryConfig,
) => Layer.Layer<Services.AuthorHistory, AuthorHistoryLayerError, AuthorHistoryRequires>;

// ── Sync engine recovery ───────────────────────────────────────────────────────────────────────
/**
 * Holds for every option below (A12): every workspace write is preceded by a durable Writing whose
 * from/to are exactly that write's tree hashes (PreparedWrite); the checkpoint advances past
 * Writing only after writeTree returned, which is after fsync. NEW for the merge case: today the
 * recovered merge writes files no checkpoint names (packages/skit/src/sync/sync.ts:516-517).
 * A lost compare-and-set on the Registry (Sync.Moved → re-read current, plan again;
 * packages/skit/src/sync/sync.ts:460-464, :583-591) is ordinary replanning, unchanged, and not
 * part of this choice.
 *
 * Decided (A12): merge. When sync finds an interrupted Writing whose files have changed since the
 * write began, it records the edited paths as a revision on the checkpoint's base and posts it,
 * merges that with the pending `to` through the ordinary merger (a path both sides changed is a
 * conflict, never an overwrite), then saves a new Writing for the merged tree (NEW) and writes it.
 * FROM CODE: packages/skit/src/sync/sync.ts:484-517.
 */
export type WritingRecovery = "merge";

// ── Commands: plain functions, no coordinator service ──────────────────────────────────────────
/**
 * `skit author sync [path] [--to] [--visibility] [--apply] [--allow-large-deletion]`
 *   handler → syncAuthorWorkspace(input, flags), a plain Effect.fn in workflows/author/sync.ts:
 *   1. root = AuthorWorkspace.resolveRoot(input).
 *   2. Preview (no --apply): no lease, no .skit, no lock. ws = read(root).
 *      Identity None → plans from Idle { base: null } over scanAuthorSyncTree(root) alone, reports
 *      that sync would create an identity, and calls neither capture nor retain: it creates no
 *      identity, device record, journal key or connection. (Sync.loadPlanInput may still cache the Registry's current
 *      revision in the content-addressed history store; accepted, decisions.md step 3 follow-ups.)
 *      Identity Some → steps 5-8, whose only write is history: capture and retain back up the
 *      files, as today (workflows/author/sync.ts:510, before the apply check at :601).
 *   3. Apply: lease = acquire(root) for the whole command (A8). ws = read(root).
 *   4. Identity (A5): None → adopt = Library.read finds an authored collection naming this root;
 *      lease.register { from: None, to: "IdentityOnly", adopt }. Some(any registration) → used as is:
 *      sync never changes registration, so Removing/Removed stay opted out of installation and
 *      sync only backs them up. Never Library.import.
 *   5. Destination = ws.connection, or NewRemote from --to and --visibility when Unconnected; flag
 *      checks as sync.ts:466-495 (pure). Connected with Leftover Matching → lease.transition
 *      { Connected(Matching) → Connected }; Mismatched or Invalid → stop and report, change nothing (A4).
 *   6. creds = Registry.credentials(destination.remote.origin); remote: SyncRemote over the authoring
 *      client (sync.ts:517-590). Until a Registry owner exists, the workflow resolves the
 *      credential for destination.remote.origin itself, so a token is only ever sent to that server.
 *   7. obs = AuthorHistory.capture(root): every tree saved before talking to the Registry (sync.ts:509-510).
 *      local = scanAuthorSyncTree(root); local.verbatimHash must equal obs.treeHash, else capture and
 *      scan again (bounded; then LocalFilesChangedDuringSync) (A14). localHash = retain(local.tree).
 *   8. Not Connected (sync.ts:594-634): preview returns first_sync_ready. Apply: NewRemote → check
 *      absent → lease.transition { Unconnected → Connecting }; create with requestId; definitive
 *      mismatch → lease.transition { Connecting → Unconnected }; on success, receipt →
 *      syncState.save(lease, key, { from: read, reset: receipt }) → lease.transition
 *      { Connecting → Connected, receipt }. A crash anywhere replays from Connecting.
 *   9. Connected: key = { workspaceId, locator }; state = syncState.read(key). Registry has no such
 *      SKIT → fail RemoteSkitUnavailable and stop, changing nothing (A16). Preview = Sync.loadPlanInput + Sync.plan with
 *      remote and engineStore. Apply = Sync.run({ store: engineStore, remote,
 *      save: next → syncState.save(lease, key, { from: last, to: next }),
 *      prepareWrite: next (a Writing) → syncState.prepareWrite(lease, key, { from: last, to: next }),
 *      whose PreparedWrite the engine hands to that Writing's one write,
 *      write: (prepared, from, to) → capture(root) *> lease.writeTree({ prepared, from, to }) })
 *      (sync.ts:636-680); an interrupted Writing follows WritingRecovery. Then capture(root) once more (sync.ts:684).
 * `skit author publish` → read once, in the workflow; require Connected, else NoRemoteHome (decided,
 *   Tim, 2026-11-04: NotBoundToRegistry and the handler's own read are removed);
 *   ignores any Leftover (the portable remote is the authority); Registry.credentials; HTTP publish.
 *   Writes no owner state, takes no lease.
 * `skit author list` → Registry.credentials; HTTP; skitLocator. Touches no owner.
 * `skit author delete` → parseAuthorDestination; Registry.credentials; HTTP. Touches no owner. The
 *   local binding and history stay as they were; the next sync fails RemoteSkitUnavailable, and
 *   reconnecting is an explicit user action, never an automatic reset (A16, product behaviour).
 * `skit author init` → root; lease = acquire(root); initSkit scaffold(lease) (plain; A11).
 *   Identity None → register { None → Registered, adopt } (adopt from Library.read, A3);
 *   IdentityOnly → { → Registered }; Removed → only with the explicit opt-in flag { → Registered,
 *   optIn }; Removing → report that a removal is unfinished; Registered → no write.
 *   Then Library.import.authored, which checks under its own writer that no other collection
 *   claims this root or id (A3). If Library refuses, the identity stays Registered: report
 *   "registered, not imported" with Library's reason; a retry reuses the same identity.
 * `skit author invocation` → lease = acquire(root); its skill-metadata write takes the lease (A11).
 * `skit library remove` of an authored collection (A15) → lease = acquire(root) when the root still
 *   exists; identity must carry the collection's workspace id (author-workspace.ts:169-184), else
 *   Library.apply alone. lease.register { → Removing } (durable intent); Library.apply(Remove);
 *   lease.register { Removing → Removed }. A crash after the intent: the retry sees Removing, runs
 *   Library.apply again only if the collection is still there, then marks Removed. Lease before
 *   the Library writer.
 */
export type Commands = never;
