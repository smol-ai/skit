import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";

export class FindingFingerprintInvalid
  extends Data.TaggedError("FindingFingerprintInvalid")<{
    value: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Copy the fingerprint from `skit security review <skill>`.";
  get message(): string {
    return `Finding fingerprint must be sha256 followed by 64 lowercase hexadecimal characters: ${this.value}`;
  }
}
