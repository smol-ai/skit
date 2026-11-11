import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

const SyncInputReason = Schema.TaggedUnion({
  SkillSelectionNotUnique: {
    query: Schema.String,
    matches: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  },
  CollectionSelectionNotUnique: {
    query: Schema.String,
    matches: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  },
  AccountEnabledListWithDeviceSelection: { keepEnabled: Schema.Array(Schema.String) },
});
type SyncInputReason = typeof SyncInputReason.Type;

export class SyncInputInvalid
  extends Schema.TaggedError<SyncInputInvalid, { readonly brand: unique symbol }>()(
    "Library.SyncInputInvalid",
    { reason: SyncInputReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}
