import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

// -- Descriptor declarations ------------------------------------------------------------------

export class DuplicateSkillNames
  extends Data.TaggedError("DuplicateSkillNames")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Give each contained Skill a unique name in the SKIT Descriptor, then retry.";
  get message(): string {
    return "Contained skill names must be unique within a SKIT";
  }
}

export class DuplicateSkillPaths
  extends Data.TaggedError("DuplicateSkillPaths")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "List each contained Skill path once in the SKIT Descriptor, then retry.";
  get message(): string {
    return "Contained skill paths must be unique within a SKIT";
  }
}

export class ConflictingInvocationDeclaration
  extends Data.TaggedError("ConflictingInvocationDeclaration")<{ skill: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Make the invocation and trigger_modes values for ${this.skill} agree, then retry.`;
  }
  get message(): string {
    return `${this.skill} declares conflicting invocation and trigger_modes values`;
  }
}

export class ReadmeFrontmatterMissing
  extends Data.TaggedError("ReadmeFrontmatterMissing")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Begin the source's README.md with YAML frontmatter, then retry.";
  get message(): string {
    return "README.md must begin with YAML frontmatter";
  }
}

export class DescriptorMalformed
  extends Data.TaggedError("DescriptorMalformed")<{
    format: "json" | "yaml";
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Correct the SKIT Descriptor in the source, then retry.";
  get message(): string {
    return `Malformed ${this.format.toUpperCase()} SKIT Descriptor: ${this.detail}`;
  }
}

// -- Skill discovery --------------------------------------------------------------------------

export class SkillDiscoveryLimitExceeded
  extends Data.TaggedError("SkillDiscoveryLimitExceeded")<{
    limit: number;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation =
    "Choose the directory that holds the Skills, rather than a larger tree, then retry.";
  get message(): string {
    return "Skill discovery exceeded directory limit";
  }
}

export class SkillNameInvalid
  extends Data.TaggedError("SkillNameInvalid")<{
    /** Path relative to the SKIT root, as the operator sees it. */
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  get remediation(): string {
    return `Give ${this.path} a lowercase, hyphenated name in its frontmatter, then retry.`;
  }
  get message(): string {
    return `${this.path} must declare a valid name`;
  }
}

export class SkitValidationFailed
  extends Data.TaggedError("SkitValidationFailed")<{
    diagnostics: readonly string[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Correct the reported diagnostics in the source, then retry.";
  get message(): string {
    return `SKIT validation failed: ${this.diagnostics.join(", ")}`;
  }
}

/**
 * Everything reading a Descriptor can reject.
 *
 * The parse helpers are synchronous and throw, so an effect that reads a Descriptor has to lift
 * them deliberately. Without that the failure arrives as a defect and the declared channel is
 * decorative rather than true.
 */
export type DescriptorFailure =
  | DescriptorMalformed
  | DuplicateSkillNames
  | DuplicateSkillPaths
  | ConflictingInvocationDeclaration
  | ReadmeFrontmatterMissing;
