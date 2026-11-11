import { Schema } from "effect";
import * as History from "../history/history.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

const RemoteInvalidReason = Schema.TaggedUnion({
  TreeMismatch: { expected: History.TreeHash, actual: History.TreeHash },
  RevisionMismatch: { actual: History.RevisionId },
});
type RemoteInvalidReason = typeof RemoteInvalidReason.Type;

/** The Registry sent a revision or tree that does not match its identity. */
export class RemoteInvalid
  extends Schema.TaggedError<RemoteInvalid, { readonly brand: unique symbol }>()(
    "Sync.RemoteInvalid",
    {
      id: History.RevisionId,
      reason: RemoteInvalidReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class InvalidTree
  extends Schema.TaggedError<InvalidTree, { readonly brand: unique symbol }>()("Sync.InvalidTree", {
    issue: History.TreePathIssue,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

/** Other devices kept moving `current` while this one tried to sync. */
export class Unsettled
  extends Schema.TaggedError<Unsettled, { readonly brand: unique symbol }>()("Sync.Unsettled", {
    steps: Schema.Int,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
}

export const SyncFailure = Schema.Union([RemoteInvalid, InvalidTree, Unsettled]);
export type SyncFailure = typeof SyncFailure.Type;
