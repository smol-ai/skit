import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

/** Another running SKIT process holds the home lock; the OS frees it when that process exits. */
export class LibraryBusy
  extends Schema.TaggedError<LibraryBusy>()("LibraryBusy", { path: Schema.String })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Wait for the other SKIT process to finish, or stop it, then retry.";
  get message(): string {
    return `Another running SKIT process holds this Library's writer lock at ${this.path}`;
  }
}
