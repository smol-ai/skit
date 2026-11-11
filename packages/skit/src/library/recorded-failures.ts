import { AuthorWorkspaceInvariantFailed } from "../author/workspace-contracts.js";
import { ArchiveStreamInvalid } from "../artifact/archive-failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { Schema, SchemaGetter } from "effect";
import { FailureCode, FailureTypeId, type SkitFailure } from "../shared/failure.js";

/** An unexpected defect is kept intact live; Effect projects native exceptions only at JSON encoding. */
export class StepDefect
  extends Schema.TaggedError<StepDefect, { readonly brand: unique symbol }>()(
    "Library.StepDefect",
    {
      defect: Schema.Union([AuthorWorkspaceInvariantFailed, ArchiveStreamInvalid, Schema.Defect()]),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

/** Native validation failure, retaining its engine object live and storing schema facts. */
export class StepSchemaFailure
  extends Schema.TaggedError<StepSchemaFailure, { readonly brand: unique symbol }>()(
    "Library.StepSchemaFailure",
    { failure: SchemaFailure },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

/** Historical text is evidence from an old writer, not a substitute for current failure facts. */
export class LegacyStepFailure
  extends Schema.TaggedError<LegacyStepFailure, { readonly brand: unique symbol }>()(
    "Library.LegacyStepFailure",
    {
      failureTag: Schema.String,
      originalCode: Schema.String,
      diagnostic: Schema.String,
      originalRemediation: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  get code(): FailureCode {
    return Schema.is(FailureCode)(this.originalCode) ? this.originalCode : "OPERATION_FAILED";
  }
}

/** Read old stopped records honestly; current writers encode the tagged historical form. */
export const LegacyStepFailureFromText = Schema.Union([
  Schema.Struct({
    _tag: Schema.String,
    code: Schema.String,
    message: Schema.String,
    remediation: Schema.String,
  }),
  LegacyStepFailure,
]).pipe(
  Schema.decodeTo(LegacyStepFailure, {
    decode: SchemaGetter.transform((value) =>
      value instanceof LegacyStepFailure
        ? value
        : new LegacyStepFailure({
            failureTag: value._tag,
            originalCode: value.code,
            diagnostic: value.message,
            originalRemediation: value.remediation,
          }),
    ),
    encode: SchemaGetter.transform((value) => new LegacyStepFailure(value)),
  }),
);
