import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class HarnessMetadataInvalid
  extends Schema.TaggedError<HarnessMetadataInvalid, { readonly brand: unique symbol }>()(
    "HarnessMetadataInvalid",
    {
      path: Schema.String,
      kind: Schema.Literals(["SKILL.md frontmatter", "Codex metadata", "OpenCode metadata"]),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}
