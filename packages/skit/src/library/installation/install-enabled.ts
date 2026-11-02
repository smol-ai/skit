import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class InstalledSkillInvalid
  extends Data.TaggedError("Library.InstalledSkillInvalid")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the Library, then retry.";
  get message(): string {
    return this.detail;
  }
}
