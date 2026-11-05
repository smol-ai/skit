import { Data } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

// -- Installed skills and state -----------------------------------------------------------------
//
// The failures below are reachable from Skill Collection content or from local state. The bare
// Errors that remain in this package are internal invariants — a malformed Harness catalog, a
// duplicate identity profile — which indicate a defect here rather than something an operator
// did, and are deliberately not part of any error channel.

export class UnsafeInstalledSkillName
  extends Data.TaggedError("UnsafeInstalledSkillName")<{
    name: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Rename the Skill to a single safe path segment, then retry.";
  get message(): string {
    return `Unsafe installed-skill name: ${this.name}`;
  }
}

export class UnsafeInstalledSkillBackups
  extends Data.TaggedError("UnsafeInstalledSkillBackups")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Replace the link or special file with a real directory, or make its .gitignore contain only `*`, keeping any existing backups, then retry.";
  get message(): string {
    return `Installed-skill backups need a real directory whose .gitignore ignores everything: ${this.path}`;
  }
}

export class SharedTargetCollision
  extends Data.TaggedError("SharedTargetCollision")<{
    target: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "TARGET_COLLISION" as const;
  readonly remediation =
    "Two Bindings route to one destination; choose a single Scope or route, then retry.";
  get message(): string {
    return `Shared target collision: ${this.target}`;
  }
}

export class InstalledPathCollision
  extends Data.TaggedError("ProjectedPathCollision")<{
    path: string;
    kind: "file" | "file-or-directory";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "TARGET_COLLISION" as const;
  readonly remediation = "Two Skills project to the same path; disable one of them, then retry.";
  get message(): string {
    return this.kind === "file"
      ? `Installed file collision: ${this.path}`
      : `Installed file/directory collision: ${this.path}`;
  }
}

export class NoSkillsDirectory
  extends Data.TaggedError("NoSkillsDirectory")<{ target: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return `Pass the root for ${this.target} with its --<harness>-root option, or run \`skit setup\`.`;
  }
  get message(): string {
    return `No skills directory configured for ${this.target}`;
  }
}

/**
 * The operating system refused a write SKIT needs in order to place copies under a skills directory.
 * Agent sandboxes do this routinely: Codex's default sandbox keeps `.agents` read-only even inside
 * its writable workspace, so the remediation names that case before ordinary permissions.
 */
export class SkillsDirectoryNotWritable
  extends Data.TaggedError("SkillsDirectoryNotWritable")<{ root: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return `If an agent sandbox is running SKIT, re-run this command with write access to ${this.root} (for example, approve running it outside the sandbox). Otherwise check that directory's permissions.`;
  }
  get message(): string {
    return `SKIT cannot write to ${this.root}: permission denied`;
  }
}

/** An installed skill was modified or is conflicted, so ownership will not be given up silently. */
export class OwnershipMarkerDisagrees
  extends Data.TaggedError("OwnershipMarkerDisagrees")<{
    skillId: string;
    target: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run `skit doctor` to inspect the installed skill before retrying.";
  get message(): string {
    return `Installed-skill state and ownership marker disagree for ${this.skillId} at ${this.target}`;
  }
}

/** Managing was explicitly approved for bytes that are no longer present at the target. */
export class ManageTargetChanged
  extends Data.TaggedError("ManageTargetChanged")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview again, then confirm against the current files.";
  get message(): string {
    return `The folder to manage changed after preview: ${this.path}`;
  }
}

/** The observed target is not the exact retained Skill selected by the managing plan. */
export class ManageContentMismatch
  extends Data.TaggedError("ManageContentMismatch")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview again, then confirm against the current files.";
  get message(): string {
    return `The folder to manage does not match the retained Skill: ${this.path}`;
  }
}

export class InstalledSkillFileMissing
  extends Data.TaggedError("InstalledSkillFileMissing")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the installed skill, then retry.";
  get message(): string {
    return `Installed skill is missing ${this.path}`;
  }
}

/**
 * An installed skill could not be retired because it no longer matches its recorded ownership.
 *
 * The caller supplies the sentence, because only it knows whether this was a disable, a removal
 * or a rematerialization. The condition is the same one either way, and naming it means callers
 * match on that rather than on a shared CONFLICT code.
 */
export class UninstallConflict
  extends Data.TaggedError("UninstallConflict")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Run `skit doctor` to inspect the changed installed skill before retrying.";
  get message(): string {
    return this.detail;
  }
}
