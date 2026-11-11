import { DescriptorIssue } from "./descriptor-issue.js";
import { SkitValidationDiagnostic } from "./validation-diagnostic.js";
import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class DuplicateSkillNames
  extends Schema.TaggedError<DuplicateSkillNames, { readonly brand: unique symbol }>()(
    "DuplicateSkillNames",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class DuplicateSkillPaths
  extends Schema.TaggedError<DuplicateSkillPaths, { readonly brand: unique symbol }>()(
    "DuplicateSkillPaths",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class ConflictingInvocationDeclaration
  extends Schema.TaggedError<ConflictingInvocationDeclaration, { readonly brand: unique symbol }>()(
    "ConflictingInvocationDeclaration",
    { skill: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class ReadmeFrontmatterMissing
  extends Schema.TaggedError<ReadmeFrontmatterMissing, { readonly brand: unique symbol }>()(
    "ReadmeFrontmatterMissing",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class DescriptorMalformed
  extends Schema.TaggedError<DescriptorMalformed, { readonly brand: unique symbol }>()(
    "DescriptorMalformed",
    { format: Schema.Literals(["json", "yaml"]), issue: DescriptorIssue },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class SkillDiscoveryLimitExceeded
  extends Schema.TaggedError<SkillDiscoveryLimitExceeded, { readonly brand: unique symbol }>()(
    "SkillDiscoveryLimitExceeded",
    { limit: Schema.Int },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class SkillNameInvalid
  extends Schema.TaggedError<SkillNameInvalid, { readonly brand: unique symbol }>()(
    "SkillNameInvalid",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class SkitValidationFailed
  extends Schema.TaggedError<SkitValidationFailed, { readonly brand: unique symbol }>()(
    "SkitValidationFailed",
    { diagnostics: Schema.Array(SkitValidationDiagnostic) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

/** Everything reading a Descriptor can reject. */
export const DescriptorFailure = Schema.Union([
  DescriptorMalformed,
  DuplicateSkillNames,
  DuplicateSkillPaths,
  ConflictingInvocationDeclaration,
  ReadmeFrontmatterMissing,
]);
export type DescriptorFailure = typeof DescriptorFailure.Type;
