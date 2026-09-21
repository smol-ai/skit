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
  collectionId: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `This directory is already retained as ${this.collectionId}; remove it before registering an Author Workspace`;
  }
}

export class AuthorWorkspaceAlreadyRegistered extends Data.TaggedError(
  "AuthorWorkspaceAlreadyRegistered",
)<{ workspaceId: string; at: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Author Workspace ${this.workspaceId} is already registered at ${this.at}`;
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
