import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class CollectionRemovalMissing
  extends Schema.TaggedError<CollectionRemovalMissing, { readonly brand: unique symbol }>()(
    "Library.CollectionRemovalMissing",
    { collection_id: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class SkillRemovalRequiresCollection
  extends Schema.TaggedError<SkillRemovalRequiresCollection, { readonly brand: unique symbol }>()(
    "Library.SkillRemovalRequiresCollection",
    { skill_id: Schema.String, collection_id: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
