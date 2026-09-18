import { Data } from "effect";

export class FindingFingerprintInvalid extends Data.TaggedError("FindingFingerprintInvalid")<{
  value: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `Finding fingerprint must be sha256 followed by 64 lowercase hexadecimal characters: ${this.value}`;
  }
}
