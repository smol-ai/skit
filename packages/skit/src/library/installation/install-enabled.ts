import { Schema } from "effect";
import { InstalledSkillFailureReason } from "../../installed-skills/files.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export const InstalledSkillInvalidReason = Schema.Union([
  InstalledSkillFailureReason,
  Schema.TaggedUnion({
    DestinationsUnknown: {},
    NotSkillFolder: { path: Schema.String },
    ManageTargetChanged: { path: Schema.String },
    ManageContentMismatch: { path: Schema.String },
    ApplyStopped: {},
    BackupNotReviewed: {},
  }),
]).annotate({ identifier: "InstalledSkillInvalidReason" });
export type InstalledSkillInvalidReason = typeof InstalledSkillInvalidReason.Type;

export class InstalledSkillInvalid
  extends Schema.TaggedError<InstalledSkillInvalid, { readonly brand: unique symbol }>()(
    "Library.InstalledSkillInvalid",
    { reason: InstalledSkillInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
