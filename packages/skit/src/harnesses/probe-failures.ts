import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { Data } from "effect";

export class UnknownHarness
  extends Data.TaggedError("UnknownHarness")<{
    value: string;
    allowed?: readonly string[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run the command with --help to see the supported harnesses.";
  get message(): string {
    return this.allowed
      ? `--for must be ${this.allowed.join(", ")}`
      : `Unknown harness: ${this.value}`;
  }
}
