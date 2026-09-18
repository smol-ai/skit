import { Data } from "effect";

export class SelectionCancelled extends Data.TaggedError("SelectionCancelled")<{
  subject: "Skill" | "Harness" | "Package" | "Collection" | "Destination" | "Login";
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.subject === "Login" ? "Login cancelled" : `${this.subject} selection cancelled`;
  }
}

export class NothingToSelect extends Data.TaggedError("NothingToSelect")<{
  detail: string;
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return this.detail;
  }
}
