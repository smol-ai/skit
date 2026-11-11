import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class SourceProcessOutputTooLarge
  extends Schema.TaggedError<SourceProcessOutputTooLarge, { readonly brand: unique symbol }>()(
    "SourceProcess.OutputTooLarge",
    {
      invocation: Schema.String,
      stream: Schema.Literals(["stdout", "stderr"]),
      limit: Schema.Int,
      actual: Schema.Int,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export class SourceProcessTimedOut
  extends Schema.TaggedError<SourceProcessTimedOut, { readonly brand: unique symbol }>()(
    "SourceProcess.TimedOut",
    { invocation: Schema.String, timeoutMs: Schema.Int },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export const SourceProcessLimitFailure = Schema.Union([
  SourceProcessOutputTooLarge,
  SourceProcessTimedOut,
]);
export type SourceProcessLimitFailure = typeof SourceProcessLimitFailure.Type;
