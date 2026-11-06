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

export class RegistryNotConfigured
  extends Data.TaggedError("RegistryNotConfigured")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "For the simplest setup, run `skit auth login https://skit.smol.ai` to use our hosted reference server. " +
    "You can also self-host the server: https://github.com/smol-ai/skit/tree/main/packages/skit-server-effect. " +
    "Pass your own Registry URL or set SKIT_SERVER_URL, then retry.";
  get message(): string {
    return "No SKIT server is configured. SKIT leaves the server choice to you, including self-hosting.";
  }
}

export class MissingRequirement
  extends Data.TaggedError("MissingRequirement")<{
    command: string;
    requires: string;
    /** Where to find a valid value, or which flags avoid the question a terminal would ask. */
    hint?: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return `Pass ${this.requires}, then retry.${this.hint === undefined ? "" : ` ${this.hint}`}`;
  }
  get message(): string {
    return `${this.command} requires ${this.requires}`;
  }
}
