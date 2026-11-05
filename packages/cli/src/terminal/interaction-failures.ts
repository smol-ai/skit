import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";

export class SelectionCancelled
  extends Data.TaggedError("SelectionCancelled")<{
    subject: "Skill" | "Harness" | "Package" | "Collection" | "Destination" | "Login";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return this.subject === "Login"
      ? "Run `skit auth login` again when ready."
      : "Run the command again and make a selection, or pass the choice as an argument.";
  }
  get message(): string {
    return this.subject === "Login" ? "Login cancelled" : `${this.subject} selection cancelled`;
  }
}

export class NothingToSelect
  extends Data.TaggedError("NothingToSelect")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation =
    "Run `skit list` to see what the Library holds, or `skit add <source>` to add Skills.";
  get message(): string {
    return this.detail;
  }
}
