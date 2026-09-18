// Named failures for the domain.
//
// SkitError carried five stringly-typed codes across 85 throw sites, 54 of them INVALID_ARGUMENT.
// That is a shared error channel: the condition was erased at the throw and re-derived at the
// boundary. These name the condition instead, and carry the fields that describe it.
//
// Each still classifies itself with a code, because callers outside this package map that to an
// exit status. The difference is that the code is now an attribute of a named failure declared
// once, rather than the failure's entire identity repeated at every site.

import { Data } from "effect";
import type { SkitErrorCode } from "./shared/skit-error.js";

/** A domain failure: named, described by its own fields, and classifiable by callers. */
export interface NamedFailure {
  readonly code: SkitErrorCode;
  readonly message: string;
}

// -- Descriptor declarations ------------------------------------------------------------------

export class DuplicateSkillNames extends Data.TaggedError("DuplicateSkillNames")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "Contained skill names must be unique within a SKIT";
  }
}

export class DuplicateSkillPaths extends Data.TaggedError("DuplicateSkillPaths")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "Contained skill paths must be unique within a SKIT";
  }
}

export class ConflictingInvocationDeclaration extends Data.TaggedError(
  "ConflictingInvocationDeclaration",
)<{ skill: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `${this.skill} declares conflicting invocation and trigger_modes values`;
  }
}

export class ReadmeFrontmatterMissing extends Data.TaggedError("ReadmeFrontmatterMissing")<{}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return "README.md must begin with YAML frontmatter";
  }
}

export class DescriptorMalformed extends Data.TaggedError("DescriptorMalformed")<{
  format: "json" | "yaml";
  detail: string;
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `Malformed ${this.format.toUpperCase()} SKIT Descriptor: ${this.detail}`;
  }
}

// -- Skill discovery --------------------------------------------------------------------------

export class SkillDiscoveryLimitExceeded extends Data.TaggedError("SkillDiscoveryLimitExceeded")<{
  limit: number;
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return "Skill discovery exceeded directory limit";
  }
}

export class SkillNameInvalid extends Data.TaggedError("SkillNameInvalid")<{
  /** Path relative to the SKIT root, as the operator sees it. */
  path: string;
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `${this.path} must declare a valid name`;
  }
}

export class SkitValidationFailed extends Data.TaggedError("SkitValidationFailed")<{
  diagnostics: readonly string[];
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `SKIT validation failed: ${this.diagnostics.join(", ")}`;
  }
}

// -- Sources ----------------------------------------------------------------------------------

export class SourceRequired extends Data.TaggedError("SourceRequired")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "SKIT source is required";
  }
}

export class UnsafeSourceUrl extends Data.TaggedError("UnsafeSourceUrl")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "SKIT URL contains unsafe characters";
  }
}

export class InsecureSourceUrl extends Data.TaggedError("InsecureSourceUrl")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "Remote SKIT URLs must use credential-free HTTPS";
  }
}

export class ArchiveEntryLimitExceeded extends Data.TaggedError("ArchiveEntryLimitExceeded")<{}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return "Archive contains too many entries";
  }
}

export class UnsafeArchivePath extends Data.TaggedError("UnsafeArchivePath")<{ path: string }> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `Unsafe archive path: ${this.path}`;
  }
}

export class SourceNotFound extends Data.TaggedError("SourceNotFound")<{ source: string }> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `Unknown or missing SKIT source: ${this.source}`;
  }
}

export class UnsafeGitSubpath extends Data.TaggedError("UnsafeGitSubpath")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "Git source subpath must be safe and relative";
  }
}

export class DirectSkillDocumentInvalid extends Data.TaggedError("DirectSkillDocumentInvalid")<{}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return "Direct SKILL.md must be Markdown with name and description frontmatter";
  }
}

export class NoSkitDescriptorFound extends Data.TaggedError("NoSkitDescriptorFound")<{}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return "Source contains no valid SKIT README.md or Agent Skills SKILL.md";
  }
}

export class RegistryNotConfigured extends Data.TaggedError("RegistryNotConfigured")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "No SKIT server is configured; run `skit auth login <origin>` or set SKIT_SERVER_URL";
  }
}

// -- Projection and state ----------------------------------------------------------------------
//
// The failures below are reachable from Skill Collection content or from local state. The bare
// Errors that remain in this package are internal invariants — a malformed Harness catalog, a
// duplicate identity profile — which indicate a defect here rather than something an operator
// did, and are deliberately not part of any error channel.

export class UnsafeProjectionName extends Data.TaggedError("UnsafeProjectionName")<{
  name: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `Unsafe projection name: ${this.name}`;
  }
}

export class SharedTargetCollision extends Data.TaggedError("SharedTargetCollision")<{
  target: string;
}> {
  readonly code = "TARGET_COLLISION" as const;
  get message(): string {
    return `Shared target collision: ${this.target}`;
  }
}

export class ProjectedPathCollision extends Data.TaggedError("ProjectedPathCollision")<{
  path: string;
  kind: "file" | "file-or-directory";
}> {
  readonly code = "TARGET_COLLISION" as const;
  get message(): string {
    return this.kind === "file"
      ? `Projected file collision: ${this.path}`
      : `Projected file/directory collision: ${this.path}`;
  }
}

export class ContentAddressCollision extends Data.TaggedError("ContentAddressCollision")<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Canonical library content-address collision";
  }
}

/**
 * A local Source was edited while it was being acquired.
 *
 * The normalized release and the verbatim Original are hashed by separate passes over the same
 * live directory. Publishing an Entry whose two content addresses came from different states of
 * that directory would describe an acquisition that never existed, so the observation is rejected
 * instead. Retrying against a settled directory is the remedy.
 */
export class SourceChangedDuringAcquisition extends Data.TaggedError(
  "SourceChangedDuringAcquisition",
)<{
  root: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Source changed while it was being retained: ${this.root}`;
  }
}

// -- Library custody ---------------------------------------------------------------------------

export class UnknownInstalledSkill extends Data.TaggedError("UnknownInstalledSkill")<{
  skillRef: string;
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `Unknown installed skill: ${this.skillRef}`;
  }
}

export class UnknownInstalledCollection extends Data.TaggedError("UnknownInstalledCollection")<{
  collectionRef: string;
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `Unknown installed SKIT: ${this.collectionRef}`;
  }
}

export class NoProjectionRoot extends Data.TaggedError("NoProjectionRoot")<{ harness: string }> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `No projection root configured for ${this.harness}`;
  }
}

/** A Projection was modified or is conflicted, so custody will not be given up silently. */
export class ProjectionNotSafeToRemove extends Data.TaggedError("ProjectionNotSafeToRemove")<{
  harness: string;
  skillRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Refusing to remove modified or conflicted ${this.harness} projection ${this.skillRef}`;
  }
}

/**
 * A pin would have to displace a Projection that is no longer the one SKIT wrote.
 *
 * Pin used to install first and report the survivors as a partial reconciliation, which left the
 * Library recording a release the Harness did not hold. Refusing while nothing has changed is the
 * simpler contract: fix or disable the affected Projections, then pin.
 */
export class ProjectionNotSafeToPin extends Data.TaggedError("ProjectionNotSafeToPin")<{
  collectionRef: string;
  conflicts: ReadonlyArray<{ skillRef: string; harness: string; projectionPath?: string }>;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    const detail = this.conflicts.map((item) => `${item.skillRef} on ${item.harness}`).join(", ");
    return `Refusing to pin ${this.collectionRef} while modified or conflicted projections would be replaced: ${detail}`;
  }
}

export class OwnershipMarkerDisagrees extends Data.TaggedError("OwnershipMarkerDisagrees")<{
  skillRef: string;
  harness: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Projection state and ownership marker disagree for ${this.skillRef} on ${this.harness}`;
  }
}

/** Explicit Adoption was approved for bytes that are no longer present at the target. */
export class AdoptionTargetChanged extends Data.TaggedError("AdoptionTargetChanged")<{
  path: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Adoption target changed after preview: ${this.path}`;
  }
}

/** The observed target is not the exact retained Skill selected by the Adoption plan. */
export class AdoptionContentMismatch extends Data.TaggedError("AdoptionContentMismatch")<{
  path: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Adoption target does not match the retained Skill: ${this.path}`;
  }
}

export class SecurityFindingAbsent extends Data.TaggedError("SecurityFindingAbsent")<{
  fingerprint: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `Finding is not present in the retained Skill Artifact: ${this.fingerprint}`;
  }
}

export class AcceptanceIncomplete extends Data.TaggedError("AcceptanceIncomplete")<{
  reason: "missing" | "invalid-expiry" | "expiry-in-past";
}> {
  readonly code = "INVALID_ARGUMENT" as const;
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

export class NotAnAuthorWorkspace extends Data.TaggedError("NotAnAuthorWorkspace")<{
  path: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `${this.path} is not an Author Workspace; invocation metadata is generated only for author-owned source, never for acquired or retained content`;
  }
}

export class ProjectionFileMissing extends Data.TaggedError("ProjectionFileMissing")<{
  path: string;
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `Projection is missing ${this.path}`;
  }
}

export class HarnessMetadataInvalid extends Data.TaggedError("HarnessMetadataInvalid")<{
  path: string;
  kind: "SKILL.md frontmatter" | "Codex metadata" | "OpenCode metadata";
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `Invalid ${this.kind}: ${this.path}`;
  }
}

/** Retained content whose diagnostics block acquisition, with the codes that blocked it. */
export class RetainedContentInvalid extends Data.TaggedError("RetainedContentInvalid")<{
  diagnostics: readonly string[];
}> {
  readonly code = "VALIDATION_FAILED" as const;
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
export class ProjectionRetireConflict extends Data.TaggedError("ProjectionRetireConflict")<{
  detail: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return this.detail;
  }
}

export class InvalidLibraryState extends Data.TaggedError("InvalidLibraryState")<{
  path: string;
  detail: string;
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return `Invalid Library state at ${this.path}: ${this.detail}`;
  }
}

export class LibraryBusy extends Data.TaggedError("LibraryBusy")<{ path: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Another SKIT command is using this Library: ${this.path}`;
  }
}
