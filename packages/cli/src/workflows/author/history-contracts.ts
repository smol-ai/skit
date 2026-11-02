import { Schema } from "effect";
import { FailureTypeId, Hash, History, type SkitFailure } from "@smolai/skit-core";

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

/** One entry in a workspace's history on this device: the revision its files were saved as. */
export const AuthorHistoryEvent = Schema.Struct({
  schema: Schema.Literal("skit.author-history-event.v2"),
  workspace_key: Hash,
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  revision: History.RevisionId,
  root: Schema.String,
  workspace_id: Schema.optionalKey(Schema.String),
});
export interface AuthorHistoryEvent extends Schema.Schema.Type<typeof AuthorHistoryEvent> {}
