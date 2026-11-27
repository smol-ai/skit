import { Schema } from "effect";
import { Hash } from "../shared/hash.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export const CollectionVersionArchiveInvalidReason = Schema.TaggedUnion({
  InvalidShape: { failure: SchemaFailure },
  InvalidBase64: { path: Schema.String },
  DuplicatePath: { path: Schema.String },
  ByteLimitExceeded: {
    kind: Schema.Literals(["encoded-file", "tree"]),
    path: Schema.String,
    limit: Schema.Int,
    actual: Schema.Int,
  },
  UnsafeSymlink: { path: Schema.String, target: Schema.String },
  ChildOfNonDirectory: { path: Schema.String },
  MissingParent: { unreachable: Schema.Int },
  HashMismatch: {
    kind: Schema.Literals(["archive", "materialized"]),
    expected: Hash,
    actual: Hash,
  },
}).annotate({ identifier: "CollectionVersionArchiveInvalidReason" });
export type CollectionVersionArchiveInvalidReason =
  typeof CollectionVersionArchiveInvalidReason.Type;

export class CollectionVersionArchiveInvalid
  extends Schema.TaggedError<CollectionVersionArchiveInvalid, { readonly brand: unique symbol }>()(
    // Released serialized tag; changing stored/wire spellings is outside this cleanup.
    "Library.SnapshotArchiveInvalid",
    { reason: CollectionVersionArchiveInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
