import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export const EditImportMissingReason = Schema.TaggedUnion({
  SkillNotFound: { query: Schema.String },
  InstalledSkillNotFound: { selector: Schema.String },
  LibraryVersionMissing: { skill: Schema.String },
  ContentUnchanged: { path: Schema.String },
});
export type EditImportMissingReason = typeof EditImportMissingReason.Type;
export class EditImportMissing
  extends Schema.TaggedError<EditImportMissing, { readonly brand: unique symbol }>()(
    "Library.EditImportMissing",
    { reason: EditImportMissingReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
}
export class EditImportAmbiguous
  extends Schema.TaggedError<EditImportAmbiguous, { readonly brand: unique symbol }>()(
    "Library.EditImportAmbiguous",
    {
      kind: Schema.Literals(["skill", "installed-skill"]),
      query: Schema.String,
      matches: Schema.Array(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
export const EditImportFailure = Schema.Union([EditImportMissing, EditImportAmbiguous]);
export type EditImportFailure = typeof EditImportFailure.Type;
