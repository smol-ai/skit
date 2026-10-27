// Failures a workflow raises about its own input, shared by the handlers that call it.

import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";

/** A required input the parser cannot enforce, such as an option that only some paths need. */
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
