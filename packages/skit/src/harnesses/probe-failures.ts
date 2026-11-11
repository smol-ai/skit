import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { Schema } from "effect";
import { SourceProcessLimitFailure } from "../platform/source-process-failures.js";
import { PlatformErrorSchema } from "../platform/error-schema.js";

export class UnknownHarness
  extends Schema.TaggedError<UnknownHarness, { readonly brand: unique symbol }>()(
    "UnknownHarness",
    { value: Schema.String, allowed: Schema.optionalKey(Schema.Array(Schema.String)) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export const HarnessProbeFailure = Schema.TaggedUnion({
  ExecutableMissing: { command: Schema.String },
  ExitCode: { command: Schema.String, exitCode: Schema.Int },
  ProcessFailed: { failure: Schema.Union([SourceProcessLimitFailure, PlatformErrorSchema]) },
});
export type HarnessProbeFailure = typeof HarnessProbeFailure.Type;
