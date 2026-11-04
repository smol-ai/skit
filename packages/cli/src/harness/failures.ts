import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";

export class NoSupportedHarnesses
  extends Data.TaggedError("NoSupportedHarnesses")<{
    aliases: readonly string[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  get remediation(): string {
    return `Install a supported harness, or name one with --for ${this.aliases.join(", ")}.`;
  }
  get message(): string {
    return `No supported harnesses detected; use --for ${this.aliases.join(", ")}`;
  }
}
