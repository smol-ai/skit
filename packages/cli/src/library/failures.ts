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
