import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

/** The home lock is held; an owner is recorded only for a released .lock encountered during import. */
export class HomeBusy
  extends Schema.TaggedError<HomeBusy, { readonly brand: unique symbol }>()("HomeBusy", {
    path: Schema.String,
    owner: Schema.optionalKey(Schema.String),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
