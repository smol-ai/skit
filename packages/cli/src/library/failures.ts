// Named failures for Library workflows.
//
// Twenty-two SkitError sites, most of them CONFLICT. Custody is the subject of nearly all of
// them, and "conflict" was not enough to tell an operator whether a directory is already
// retained, whether its identity moved, or whether the acquired bytes disagree with the Registry.

import { Data } from "effect";

/** A preview the operator confirmed no longer describes the Library. */
export class PlanIsStale extends Data.TaggedError("PlanIsStale")<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "The Library changed since this plan was previewed. Review the refreshed state and try again.";
  }
}

/** A local Adoption preview contains policy blockers and therefore cannot be applied. */
export class LocalAdoptionBlocked extends Data.TaggedError("LocalAdoptionBlocked")<{
  blockers: ReadonlyArray<{ path: string; reason: string }>;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Local Adoption is blocked: ${this.blockers
      .map((item) => (item.path ? `${item.reason} (${item.path})` : item.reason))
      .join(", ")}`;
  }
}

// -- Author Workspaces ---------------------------------------------------------------------------

export class AuthorWorkspaceMetadataInvalid extends Data.TaggedError(
  "AuthorWorkspaceMetadataInvalid",
)<{ path: string }> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `Invalid Author Workspace metadata at ${this.path}`;
  }
}

export class DirectoryAlreadyRetained extends Data.TaggedError("DirectoryAlreadyRetained")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `This directory is already retained as ${this.collectionRef}; remove it before registering an Author Workspace`;
  }
}

export class AuthorWorkspaceAlreadyRegistered extends Data.TaggedError(
  "AuthorWorkspaceAlreadyRegistered",
)<{ collectionRef: string; at: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Author Workspace ${this.collectionRef} is already registered at ${this.at}`;
  }
}

/** The directory is already an editable Entry, so retaining a copy of it is the wrong move. */
export class EditableEntryExists extends Data.TaggedError("EditableEntryExists")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `This directory is registered as ${this.collectionRef}; use that editable Entry instead of \`skit add .\``;
  }
}

// -- Retention and identity ----------------------------------------------------------------------

/**
 * An Installation exists for this Collection with Projections, but no Entry refers to it.
 *
 * Add would replace that Installation, and replacing it retires the Projections of any Skill the
 * incoming content drops. Compensation can put a retained release back, but not those Projections:
 * the Installation record that described them is gone once they are retired, and without an Entry
 * there is no Binding recording the Skill selection, invocation override or Scope to reproject
 * from. Rather than mutate and then be unable to restore, add refuses while the state is intact.
 */
export class ProjectedInstallationWithoutEntry extends Data.TaggedError(
  "ProjectedInstallationWithoutEntry",
)<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `${this.collectionRef} has projected Skills but no Library Entry; run \`skit doctor\` and remove or repair it before adding it again`;
  }
}

export class SourceAlreadyRetained extends Data.TaggedError("SourceAlreadyRetained")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Source ${this.collectionRef} already exists; use pull to update it`;
  }
}

/**
 * A Source now resolves to a different Collection Identity than the one retained.
 *
 * The three places this happens differ only in what the operator should do next, which is why
 * that is a field rather than three conditions.
 */
export class SourceIdentityChanged extends Data.TaggedError("SourceIdentityChanged")<{
  from: string;
  to?: string;
  context: "update" | "pull" | "pin" | "author-workspace";
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    if (this.context === "author-workspace")
      return `Author Workspace identity changed for ${this.from}`;
    if (this.context === "pin")
      return `Pinned source identity changed from ${this.from} to ${this.to}`;
    if (this.context === "pull")
      return `Source identity changed from ${this.from} to ${this.to}; remove and add it explicitly`;
    return `Source identity changed from ${this.from} to ${this.to}`;
  }
}

export class NoPortableLocator extends Data.TaggedError("NoPortableLocator")<{
  displayId: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Device-local source ${this.displayId} has no portable locator`;
  }
}

export class AcquiredEntryMismatch extends Data.TaggedError("AcquiredEntryMismatch")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Acquired Library Entry ${this.collectionRef} does not match its remote identity or digest`;
  }
}

// -- Queries ---------------------------------------------------------------------------------------

/**
 * A query that matched nothing, or matched more than one thing.
 *
 * These were one throw choosing between two codes and two sentences. They are two conditions:
 * an operator narrows an ambiguous query and corrects an unknown one.
 */
export class AmbiguousQuery extends Data.TaggedError("AmbiguousQuery")<{
  query: string;
  subject: "skill" | "source or skill";
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Ambiguous ${this.subject}: ${this.query}`;
  }
}

export class UnknownQuery extends Data.TaggedError("UnknownQuery")<{
  query: string;
  subject: "skill" | "source or skill";
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `Unknown ${this.subject}: ${this.query}`;
  }
}

export class SkillRequired extends Data.TaggedError("SkillRequired")<{ action: string }> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `${this.action} requires a Skill, not a Collection`;
  }
}

// -- Registry access --------------------------------------------------------------------------------

export class CredentialLacksAccess extends Data.TaggedError("CredentialLacksAccess")<{
  locator: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `The active credential cannot access ${this.locator}; run \`skit auth login <origin>\` with the required scopes`;
  }
}

export class ExactReleaseUnavailable extends Data.TaggedError("ExactReleaseUnavailable")<{
  locator: string;
  version: string;
  detail: string;
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `Unable to acquire ${this.locator} at exact release ${this.version}: ${this.detail}`;
  }
}

export class PinRequiresRegistry extends Data.TaggedError("PinRequiresRegistry")<{
  collectionRef: string;
  sourceType: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `Exact release pinning currently requires a Registry Entry; ${this.collectionRef} uses ${this.sourceType}`;
  }
}

// -- Portable Library reconciliation ---------------------------------------------------------------
//
// Eight sites, every one CONFLICT. Reconciliation is where a portable manifest meets local
// custody, and an operator resolving it needs to know which of these it hit.

export class BindingEntryMissing extends Data.TaggedError("BindingEntryMissing")<{
  collectionRef: string;
  side: "local" | "remote";
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return this.side === "local"
      ? `Cannot reconcile Binding for missing Library Entry ${this.collectionRef}`
      : `Remote Binding references missing Library Entry ${this.collectionRef}`;
  }
}

export class RepositoryMappingRequired extends Data.TaggedError("RepositoryMappingRequired")<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Remote repository Bindings require a local repository mapping";
  }
}

export class RemoteEntryUsesLocalLocator extends Data.TaggedError("RemoteEntryUsesLocalLocator")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Remote Library Entry ${this.collectionRef} cannot use a local filesystem locator`;
  }
}

export class EntryDoesNotMatchAcquired extends Data.TaggedError("EntryDoesNotMatchAcquired")<{
  collectionRef: string;
  acquiredRef: string;
  digest: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Library Entry ${this.collectionRef} does not match acquired ${this.acquiredRef} or digest ${this.digest}`;
  }
}

export class BindingSkillUnavailable extends Data.TaggedError("BindingSkillUnavailable")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Remote Binding for ${this.collectionRef} references an unavailable skill`;
  }
}

export class NoPortableRepositoryIdentity extends Data.TaggedError("NoPortableRepositoryIdentity")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Repository binding for ${this.collectionRef} has no portable repository identity`;
  }
}

export class NoPortableGitRevision extends Data.TaggedError("NoPortableGitRevision")<{
  collectionRef: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Git Entry ${this.collectionRef} has no recorded commit. Run skit update ${this.collectionRef} explicitly before syncing; the retained historical revision cannot be inferred.`;
  }
}
