import { Data, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class ContentAddressCollision
  extends Data.TaggedError("ContentAddressCollision")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run `skit doctor` to inspect the Library before retrying.";
  get message(): string {
    return "Canonical library content-address collision";
  }
}

// -- Library ownership ---------------------------------------------------------------------------

export class UnknownInstalledSkill
  extends Data.TaggedError("UnknownInstalledSkill")<{
    query: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Run `skit list` to find an installed Skill.";
  get message(): string {
    return `Unknown installed skill: ${this.query}`;
  }
}

export class SecurityFindingAbsent
  extends Data.TaggedError("SecurityFindingAbsent")<{
    fingerprint: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Run `skit security review <skill>` to list the findings in the retained Skill.";
  get message(): string {
    return `Finding is not present in the retained Skill Artifact: ${this.fingerprint}`;
  }
}

export class AcceptanceIncomplete
  extends Data.TaggedError("AcceptanceIncomplete")<{
    reason: "missing" | "invalid-expiry" | "expiry-in-past";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return this.reason === "missing"
      ? "Pass --principal and --rationale, then retry."
      : "Pass --expires-at as a future ISO instant, such as 2030-01-01T00:00:00Z.";
  }
  get message(): string {
    return this.reason === "missing"
      ? "Principal and rationale are required"
      : this.reason === "invalid-expiry"
        ? "expires-at must be a valid ISO instant"
        : "expires-at must be later than acceptance time";
  }
}

/** Retained content whose diagnostics block acquisition, with the codes that blocked it. */
export class ImportContentInvalid
  extends Data.TaggedError("ImportContentInvalid")<{
    diagnostics: readonly string[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Correct the reported diagnostics in the source, then add it again.";
  get message(): string {
    return `SKIT validation failed: ${this.diagnostics.join(", ")}`;
  }
}

export class InvalidLibraryState
  extends Schema.TaggedError<InvalidLibraryState>()("InvalidLibraryState", {
    path: Schema.String,
    detail: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation =
    "Back up the state file before recovery. To reset an alpha Library, move it aside and run `skit setup`; keep installed Skill files.";
  get message(): string {
    return `Invalid Library state at ${this.path}: ${this.detail}`;
  }
}

/** The Library moved on since the state a change was planned from; nothing was saved. */
export class LibraryChanged
  extends Schema.TaggedError<LibraryChanged>()("LibraryChanged", { path: Schema.String })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run the command again.";
  get message(): string {
    return `The Library changed while this command ran; run it again: ${this.path}`;
  }
}
