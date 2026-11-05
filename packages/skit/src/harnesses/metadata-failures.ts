import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class HarnessMetadataInvalid
  extends Data.TaggedError("HarnessMetadataInvalid")<{
    path: string;
    kind: "SKILL.md frontmatter" | "Codex metadata" | "OpenCode metadata";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  get remediation(): string {
    return `Correct the YAML in ${this.path}, then retry.`;
  }
  get message(): string {
    return `Invalid ${this.kind}: ${this.path}`;
  }
}
