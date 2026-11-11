import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { FileLockFailureCause } from "../platform/file-lock-failures.js";
import { AuthorRemoteHome, AuthorVisibility } from "./remote.js";
import {
  AuthorDestinationMalformed,
  AuthorDestinationInvalid,
  InsecureOrigin,
} from "./failures.js";

export const SyncStateInvalidReason = Schema.TaggedUnion({
  InvalidData: { failure: SchemaFailure },
  RemoteInvalid: {
    failure: Schema.Union([AuthorDestinationMalformed, AuthorDestinationInvalid, InsecureOrigin]),
  },
  NoncanonicalDestination: {},
  MismatchedRemote: { expected: Schema.String, actual: Schema.String },
});
export type SyncStateInvalidReason = typeof SyncStateInvalidReason.Type;
export const WorkspaceUnsafeReason = Schema.TaggedUnion({
  RootChanged: {},
  ControlNotDirectory: {},
  LockNotFile: {},
  LockFailed: { cause: FileLockFailureCause },
  LeaseRootMismatch: { leaseRoot: Schema.String },
  WatchedRootReplaced: {},
});
export type WorkspaceUnsafeReason = typeof WorkspaceUnsafeReason.Type;

/** `workspace_<32 hex>`. Device-local, never portable (ADR-0026). */
export const WorkspaceId = Schema.String.check(Schema.isPattern(/^workspace_[a-f0-9]{32}$/u)).pipe(
  Schema.brand("WorkspaceId"),
);
export type WorkspaceId = typeof WorkspaceId.Type;

/**
 * The workspace's device-local identity. Whether its Collection is in the Library is the
 * Library's state, never stored here: a workspace is registered while the Library retains a
 * Collection imported from it.
 */
export const Identity = Schema.Struct({ workspaceId: WorkspaceId });
export type Identity = typeof Identity.Type;

/** realPath(resolve(input)) of an existing directory. Minted only by AuthorWorkspace.resolveRoot. */
export const WorkspaceRoot = Schema.String.pipe(Schema.brand("WorkspaceRoot"));
export type WorkspaceRoot = typeof WorkspaceRoot.Type;

/** Saved recovery state must be readable before sync may change files or the Registry. */
export class AuthorSyncStateInvalid
  extends Schema.TaggedError<AuthorSyncStateInvalid, { readonly brand: unique symbol }>()(
    "AuthorSyncStateInvalid",
    {
      path: Schema.String,
      reason: SyncStateInvalidReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
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
export const Leftover = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Matching", { checkpoint: Connecting }),
  Schema.TaggedStruct("Mismatched", { checkpoint: Connecting }),
  Schema.TaggedStruct("Invalid", { error: AuthorSyncStateInvalid }),
]);
export type Leftover = typeof Leftover.Type;

/** One logical state over two files: a valid skit.remote.json is Connected whatever else is there. */
export const Connection = Schema.Union([
  Schema.TaggedStruct("Unconnected", {}),
  Connecting,
  Schema.TaggedStruct("Connected", { remote: AuthorRemoteHome, leftover: Leftover }),
]);
export type Connection = typeof Connection.Type;
export type Connected = Extract<Connection, { _tag: "Connected" }>;

/** One read of all four files. */
export const Workspace = Schema.Struct({
  root: WorkspaceRoot,
  identity: Schema.OptionFromOptionalKey(Identity),
  connection: Connection,
});
export type Workspace = typeof Workspace.Type;

/** Which sync checkpoint: workspace identity plus SKIT locator (A5). */
export const SyncKey = Schema.Struct({ workspaceId: WorkspaceId, locator: Schema.String });
export type SyncKey = typeof SyncKey.Type;

/** What a transition or register planned from is no longer what is on disk. */
export class AuthorWorkspaceConflict
  extends Schema.TaggedError<AuthorWorkspaceConflict, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceConflict",
    {
      root: WorkspaceRoot,
      found: Workspace,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

/** The input is not an existing directory (A1). */
export class AuthorWorkspaceRootInvalid
  extends Schema.TaggedError<AuthorWorkspaceRootInvalid, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceRootInvalid",
    {
      input: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

/**
 * The lease could not be taken safely: the root no longer realPaths to itself, .skit is not a
 * real directory, or the lock is a symlink, not a regular file, or not a lock SQLite can take.
 */
export class AuthorWorkspaceUnsafe
  extends Schema.TaggedError<AuthorWorkspaceUnsafe, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceUnsafe",
    {
      path: Schema.String,
      reason: WorkspaceUnsafeReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

/** Another process (or this one) holds the workspace lease. */
export class AuthorWorkspaceBusy
  extends Schema.TaggedError<AuthorWorkspaceBusy, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceBusy",
    { root: WorkspaceRoot },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
}

/** A caller violated the lifetime or checkpoint protocol owned by AuthorWorkspace. */
export const AuthorWorkspaceInvariantReason = Schema.TaggedUnion({
  LeaseClosed: {},
  WriteNotOwned: { key: SyncKey },
  CheckpointChanged: { key: SyncKey },
  WriteAlreadyUsed: { key: SyncKey },
  TreesDiffer: { key: SyncKey },
});
export class AuthorWorkspaceInvariantFailed
  extends Schema.TaggedError<AuthorWorkspaceInvariantFailed, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceInvariantFailed",
    { root: WorkspaceRoot, reason: AuthorWorkspaceInvariantReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

const workspaceFailures = Schema.Union([
  AuthorSyncStateInvalid,
  AuthorWorkspaceConflict,
  AuthorWorkspaceRootInvalid,
  AuthorWorkspaceUnsafe,
  AuthorWorkspaceBusy,
]);
export type WorkspaceFailure = typeof workspaceFailures.Type;
type EncodedWorkspaceFailure = typeof workspaceFailures.Encoded;
export const WorkspaceFailure: Schema.Codec<WorkspaceFailure, EncodedWorkspaceFailure> =
  workspaceFailures;
