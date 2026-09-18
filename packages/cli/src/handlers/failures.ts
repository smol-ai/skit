import { Data } from "effect";

/** A required input the parser cannot enforce, such as an option that only some paths need. */
export class MissingRequirement extends Data.TaggedError("MissingRequirement")<{
  command: string;
  requires: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `${this.command} requires ${this.requires}`;
  }
}

export class OptionCombinationInvalid extends Data.TaggedError("OptionCombinationInvalid")<{
  detail: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.detail;
  }
}

export class CommandRequired extends Data.TaggedError("CommandRequired")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "A command is required";
  }
}

export class PackageMetadataUnavailable extends Data.TaggedError("PackageMetadataUnavailable")<{}> {
  get message(): string {
    return "Unable to locate valid CLI package metadata";
  }
}
