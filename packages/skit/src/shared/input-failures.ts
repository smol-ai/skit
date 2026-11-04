import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "./failure.js";

export class OptionCombinationInvalid
  extends Data.TaggedError("OptionCombinationInvalid")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run the command with --help to review how its options combine.";
  get message(): string {
    return this.detail;
  }
}
