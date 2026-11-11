import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SourceProcessLimitFailure } from "../platform/source-process-failures.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";

export class CollectionNotUpdatable
  extends Schema.TaggedError<CollectionNotUpdatable, { readonly brand: unique symbol }>()(
    "Library.CollectionNotUpdatable",
    { subject_id: Schema.String, label: Schema.String, source: Schema.optionalKey(Schema.String) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
export class ReviewedChangeDiffers
  extends Schema.TaggedError<ReviewedChangeDiffers, { readonly brand: unique symbol }>()(
    "Library.ReviewedChangeDiffers",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
export const GitInspectionFailureReason = Schema.TaggedUnion({
  ProcessFailed: { failure: Schema.Union([SourceProcessLimitFailure, PlatformErrorSchema]) },
  ExitCode: { exitCode: Schema.Int, stderr: Schema.String },
});
export type GitInspectionFailureReason = typeof GitInspectionFailureReason.Type;
export class GitInspectionFailed
  extends Schema.TaggedError<GitInspectionFailed, { readonly brand: unique symbol }>()(
    "SkillsSh.GitInspectionFailed",
    { operation: Schema.String, reason: GitInspectionFailureReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export const UpdateFailure = Schema.Union([
  CollectionNotUpdatable,
  ReviewedChangeDiffers,
  GitInspectionFailed,
]);
export type UpdateFailure = typeof UpdateFailure.Type;
