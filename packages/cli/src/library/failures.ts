// Named failures for Library workflows.
//
// Twenty-two SkitError sites, most of them CONFLICT. Ownership is the subject of nearly all of
// them, and "conflict" was not enough to tell an operator whether a directory is already
// retained, whether its identity moved, or whether the acquired bytes disagree with the Registry.

import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Data, Schema } from "effect";

// -- Author Workspaces ---------------------------------------------------------------------------

export class DirectoryAlreadyInLibrary
  extends Data.TaggedError("DirectoryAlreadyInLibrary")<{
    collectionId: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Run \`skit remove ${this.collectionId}\`, then register the Author Workspace.`;
  }
  get message(): string {
    return `This directory is already retained as ${this.collectionId}; remove it before registering an Author Workspace`;
  }
}

/** A Library removal recorded its intent on the workspace but the Collection is still there (A15). */
export class AuthorWorkspaceRemovalUnfinished
  extends Schema.TaggedError<AuthorWorkspaceRemovalUnfinished>()(
    "AuthorWorkspaceRemovalUnfinished",
    { collectionId: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Run \`skit remove ${this.collectionId}\` to finish removing it, then initialize the workspace again with --register.`;
  }
  get message(): string {
    return `Removing this Author Workspace's Collection ${this.collectionId} did not finish`;
  }
}
