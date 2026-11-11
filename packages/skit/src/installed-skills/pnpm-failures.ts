import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

/** Native filesystem evidence remains live until the executable logs it. */
export const PnpmEvidenceUnreadable = Schema.TaggedStruct("PnpmEvidenceUnreadable", {
  path: Schema.String,
  failure: Schema.Unknown,
});
export type PnpmEvidenceUnreadable = typeof PnpmEvidenceUnreadable.Type;

export class PnpmSkillManaged
  extends Schema.TaggedError<PnpmSkillManaged, { readonly brand: unique symbol }>()(
    "PnpmSkillManaged",
    { path: Schema.String, package: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
