import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

// -- Installed skills and state -----------------------------------------------------------------
//
// The failures below are reachable from Skill Collection content or from local state. The bare
// Errors that remain in this package are internal invariants — a malformed Harness catalog, a
// duplicate identity profile — which indicate a defect here rather than something an operator
// did, and are deliberately not part of any error channel.

export class UnsafeInstalledSkillName
  extends Schema.TaggedError<UnsafeInstalledSkillName, { readonly brand: unique symbol }>()(
    "UnsafeInstalledSkillName",
    { skillName: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class UnsafeInstalledSkillBackups
  extends Schema.TaggedError<UnsafeInstalledSkillBackups, { readonly brand: unique symbol }>()(
    "UnsafeInstalledSkillBackups",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class SharedTargetCollision
  extends Schema.TaggedError<SharedTargetCollision, { readonly brand: unique symbol }>()(
    "SharedTargetCollision",
    { target: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "TARGET_COLLISION" as const;
}

export class InstalledPathCollision
  extends Schema.TaggedError<InstalledPathCollision, { readonly brand: unique symbol }>()(
    // Released serialized tag; changing stored/wire spellings is outside this cleanup.
    "ProjectedPathCollision",
    { path: Schema.String, kind: Schema.Literals(["file", "file-or-directory"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "TARGET_COLLISION" as const;
}

/**
 * The operating system refused a write SKIT needs in order to place copies under a skills directory.
 * Agent sandboxes do this routinely: Codex's default sandbox keeps `.agents` read-only even inside
 * its writable workspace, so the remediation names that case before ordinary permissions.
 */
export class SkillsDirectoryNotWritable
  extends Schema.TaggedError<SkillsDirectoryNotWritable, { readonly brand: unique symbol }>()(
    "SkillsDirectoryNotWritable",
    { root: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

/** An installed skill was modified or is conflicted, so ownership will not be given up silently. */
export class OwnershipMarkerDisagrees
  extends Schema.TaggedError<OwnershipMarkerDisagrees, { readonly brand: unique symbol }>()(
    "OwnershipMarkerDisagrees",
    { skillId: Schema.String, target: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class InstalledSkillFileMissing
  extends Schema.TaggedError<InstalledSkillFileMissing, { readonly brand: unique symbol }>()(
    "InstalledSkillFileMissing",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

/** An installed folder changed, so uninstalling it would lose an unreviewed edit. */
export class UninstallConflict
  extends Schema.TaggedError<UninstallConflict, { readonly brand: unique symbol }>()(
    "UninstallConflict",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}
