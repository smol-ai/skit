import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

/** Another running SKIT process holds the home lock; the OS frees it when that process exits. */
export class HomeBusy
  extends Schema.TaggedError<HomeBusy, { readonly brand: unique symbol }>()("HomeBusy", {
    path: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
