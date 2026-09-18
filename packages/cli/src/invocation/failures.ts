import { Data } from "effect";

export class UnknownInvocationPolicy extends Data.TaggedError("UnknownInvocationPolicy")<{
  value: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `Unknown invocation policy: ${this.value}`;
  }
}
