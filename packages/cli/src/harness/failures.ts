import { Data } from "effect";

export class UnknownHarness extends Data.TaggedError("UnknownHarness")<{
  value: string;
  allowed?: readonly string[];
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.allowed
      ? `--for must be ${this.allowed.join(", ")}`
      : `Unknown harness: ${this.value}`;
  }
}

export class NoSupportedHarnesses extends Data.TaggedError("NoSupportedHarnesses")<{
  aliases: readonly string[];
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `No supported harnesses detected; use --for ${this.aliases.join(", ")}`;
  }
}
