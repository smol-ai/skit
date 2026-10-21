// Named failures for the domain.
//
// SkitError carried five stringly-typed codes across 85 throw sites, 54 of them INVALID_ARGUMENT.
// That is a shared error channel: the condition was erased at the throw and re-derived at the
// boundary. These name the condition instead, and carry the fields that describe it.
//
// Each still classifies itself with a code, because callers outside this package map that to an
// exit status. The difference is that the code is now an attribute of a named failure declared
// once, rather than the failure's entire identity repeated at every site.

import { FailureTypeId, type SkitFailure } from "./shared/failure.js";
import { Data } from "effect";

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

// -- Sources ----------------------------------------------------------------------------------

export class SourceRequired extends Data.TaggedError("SourceRequired")<{}> implements SkitFailure {
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Pass a SKIT source, such as owner/repository, a local path, or an HTTPS or Git URL.";
  get message(): string {
    return "SKIT source is required";
  }
}

export class UnsafeSourceUrl
  extends Data.TaggedError("UnsafeSourceUrl")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Remove whitespace and control characters from the SKIT URL, then retry.";
  get message(): string {
    return "SKIT URL contains unsafe characters";
  }
}

export class InsecureSourceUrl
  extends Data.TaggedError("InsecureSourceUrl")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Use an https:// URL without a username or password in it.";
  get message(): string {
    return "Remote SKIT URLs must use credential-free HTTPS";
  }
}

export class ArchiveEntryLimitExceeded
  extends Data.TaggedError("ArchiveEntryLimitExceeded")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation =
    "Choose a smaller source; this archive has more entries than SKIT will unpack.";
  get message(): string {
    return "Archive contains too many entries";
  }
}

export class UnsafeArchivePath
  extends Data.TaggedError("UnsafeArchivePath")<{ path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Choose a source whose archive entries stay inside its root.";
  get message(): string {
    return `Unsafe archive path: ${this.path}`;
  }
}

export class SourceNotFound
  extends Data.TaggedError("SourceNotFound")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Check the source path or URL, then retry.";
  get message(): string {
    return `Unknown or missing SKIT source: ${this.source}`;
  }
}

export class UnsafeGitSubpath
  extends Data.TaggedError("UnsafeGitSubpath")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Name a relative directory inside the repository, without `..`.";
  get message(): string {
    return "Git source subpath must be safe and relative";
  }
}

export class GitSourceFragment
  extends Data.TaggedError("GitSourceFragment")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Remove the # fragment, or use a GitHub tree URL to select a ref or directory.";
  get message(): string {
    return `Git source ${this.source} has a # fragment. A Git remote is acquired from its default branch and root; on GitHub, use a tree URL (https://github.com/<owner>/<repository>/tree/<ref>/<path>) to select a ref or directory`;
  }
}

export class DirectSkillDocumentInvalid
  extends Data.TaggedError("DirectSkillDocumentInvalid")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Give the SKILL.md frontmatter a name and description, then retry.";
  get message(): string {
    return "Direct SKILL.md must be Markdown with name and description frontmatter";
  }
}

export class NoSkitDescriptorFound
  extends Data.TaggedError("NoSkitDescriptorFound")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Choose a source containing a SKILL.md or a SKIT README.md, then retry.";
  get message(): string {
    return "Source contains no valid SKIT README.md or Agent Skills SKILL.md";
  }
}

export class RegistryNotConfigured
  extends Data.TaggedError("RegistryNotConfigured")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "For the simplest setup, run `skit auth login https://skit.smol.ai` to use our hosted reference server. " +
    "You can also self-host the server: https://github.com/smol-ai/skit/tree/main/packages/skit-server-effect. " +
    "Pass your own Registry URL or set SKIT_SERVER_URL, then retry.";
  get message(): string {
    return "No SKIT server is configured. SKIT leaves the server choice to you, including self-hosting.";
  }
}

// -- Projection and state ----------------------------------------------------------------------
//
// The failures below are reachable from Skill Collection content or from local state. The bare
// Errors that remain in this package are internal invariants — a malformed Harness catalog, a
// duplicate identity profile — which indicate a defect here rather than something an operator
// did, and are deliberately not part of any error channel.

export class UnsafeProjectionName
  extends Data.TaggedError("UnsafeProjectionName")<{
    name: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Rename the Skill to a single safe path segment, then retry.";
  get message(): string {
    return `Unsafe projection name: ${this.name}`;
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

export class ProjectedPathCollision
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
      ? `Projected file collision: ${this.path}`
      : `Projected file/directory collision: ${this.path}`;
  }
}

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

// -- Library custody ---------------------------------------------------------------------------

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

export class NoProjectionRoot
  extends Data.TaggedError("NoProjectionRoot")<{ target: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return `Pass the root for ${this.target} with its --<harness>-root option, or run \`skit setup\`.`;
  }
  get message(): string {
    return `No projection root configured for ${this.target}`;
  }
}

/** A Projection was modified or is conflicted, so custody will not be given up silently. */
export class OwnershipMarkerDisagrees
  extends Data.TaggedError("OwnershipMarkerDisagrees")<{
    skillId: string;
    target: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run `skit doctor` to inspect the Projection before retrying.";
  get message(): string {
    return `Projection state and ownership marker disagree for ${this.skillId} at ${this.target}`;
  }
}

/** Explicit Adoption was approved for bytes that are no longer present at the target. */
export class AdoptionTargetChanged
  extends Data.TaggedError("AdoptionTargetChanged")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the adoption again, then confirm it against the current files.";
  get message(): string {
    return `Adoption target changed after preview: ${this.path}`;
  }
}

/** The observed target is not the exact retained Skill selected by the Adoption plan. */
export class AdoptionContentMismatch
  extends Data.TaggedError("AdoptionContentMismatch")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the adoption again, then confirm it against the current files.";
  get message(): string {
    return `Adoption target does not match the retained Skill: ${this.path}`;
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

// -- Authoring and Harness metadata -------------------------------------------------------------

export class NotAnAuthorWorkspace
  extends Data.TaggedError("NotAnAuthorWorkspace")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Run the command in an Author Workspace, the source directory you author a SKIT in.";
  get message(): string {
    return `${this.path} is not an Author Workspace; invocation metadata is generated only for author-owned source, never for acquired or retained content`;
  }
}

export class ProjectionFileMissing
  extends Data.TaggedError("ProjectionFileMissing")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the Projection, then retry.";
  get message(): string {
    return `Projection is missing ${this.path}`;
  }
}

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

/** Retained content whose diagnostics block acquisition, with the codes that blocked it. */
export class RetainedContentInvalid
  extends Data.TaggedError("RetainedContentInvalid")<{
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

/**
 * A Projection could not be retired because it no longer matches its recorded custody.
 *
 * The caller supplies the sentence, because only it knows whether this was a disable, a removal
 * or a rematerialization. The condition is the same one either way, and naming it means callers
 * match on that rather than on a shared CONFLICT code.
 */
export class ProjectionRetireConflict
  extends Data.TaggedError("ProjectionRetireConflict")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run `skit doctor` to inspect the changed Projection before retrying.";
  get message(): string {
    return this.detail;
  }
}

export class InvalidLibraryState
  extends Data.TaggedError("InvalidLibraryState")<{
    path: string;
    detail: string;
  }>
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

export class LibraryBusy
  extends Data.TaggedError("LibraryBusy")<{ path: string; owner: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Wait for the other SKIT process to finish, then retry.";
  get message(): string {
    return `Another SKIT process (${this.owner}, as pid@host) holds this Library's writer lock at ${this.path}. Remove that file only after confirming that process has stopped, then retry`;
  }
}

/** The Library moved on since the state a change was planned from; nothing was published. */
export class LibraryChanged
  extends Data.TaggedError("LibraryChanged")<{ path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run the command again.";
  get message(): string {
    return `The Library changed while this command ran; run it again: ${this.path}`;
  }
}
