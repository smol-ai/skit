import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

/** The ZIP writer did not supply the Node readable stream required for scoped cleanup. */
export class ArchiveStreamInvalid
  extends Schema.TaggedError<ArchiveStreamInvalid, { readonly brand: unique symbol }>()(
    "ArchiveStreamInvalid",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
