import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import * as History from "../history/history.js";
import * as Sync from "../sync/sync.js";
import { SyncKey, WorkspaceRoot } from "./workspace-contracts.js";

export const AuthorHistoryInvalidReason = Schema.TaggedUnion({
  AmbiguousWorkspace: {},
  JournalVersionInvalid: { failure: SchemaFailure },
  JournalWorkspaceMismatch: { expected: Schema.String, actual: Schema.String },
  JournalFailure: { cause: Schema.Defect() },
  JournalSchemaInvalid: { failure: SchemaFailure },
  StoreFailure: { failure: History.StoreError },
  HistoryInsideWorkspace: { workspace: WorkspaceRoot, resolved: Schema.Boolean },
  JournalRedirected: {},
  BackupParentMismatch: {
    expected: Schema.NullOr(History.RevisionId),
    actual: Schema.Array(History.RevisionId),
  },
  InvalidTree: { issue: History.TreePathIssue },
  BackupNotAncestor: { acknowledged: History.RevisionId, observation: History.RevisionId },
  BackupDisconnected: {},
});
export type AuthorHistoryInvalidReason = typeof AuthorHistoryInvalidReason.Type;

export class AuthorHistoryInvalid
  extends Schema.TaggedError<AuthorHistoryInvalid, { readonly brand: unique symbol }>()(
    "AuthorHistoryInvalid",
    {
      path: Schema.String,
      reason: AuthorHistoryInvalidReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

/** Contention is temporary; it says nothing about the validity of stored history. */
export class AuthorHistoryBusy
  extends Schema.TaggedError<AuthorHistoryBusy, { readonly brand: unique symbol }>()(
    "AuthorHistoryBusy",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
}

/** The saved checkpoint is no longer the one the step planned from. */
export class AuthorSyncStateConflict
  extends Schema.TaggedError<AuthorSyncStateConflict, { readonly brand: unique symbol }>()(
    "AuthorSyncStateConflict",
    {
      key: SyncKey,
      found: Sync.SyncState,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
}

/** Another backup pass advanced this workspace's acknowledged observation. */
export class AuthorBackupStateConflict
  extends Schema.TaggedError<AuthorBackupStateConflict, { readonly brand: unique symbol }>()(
    "AuthorBackupStateConflict",
    {
      key: SyncKey,
      found: Schema.NullOr(History.RevisionId),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
}

export const AuthorHistoryFailure = Schema.Union([
  AuthorHistoryInvalid,
  AuthorHistoryBusy,
  AuthorSyncStateConflict,
  AuthorBackupStateConflict,
]);
export type AuthorHistoryFailure = typeof AuthorHistoryFailure.Type;
