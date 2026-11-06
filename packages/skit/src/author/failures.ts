import { Data, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class AuthorWorkspaceMetadataInvalid
  extends Data.TaggedError("AuthorWorkspaceMetadataInvalid")<{ path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return `Correct or remove the Author Workspace metadata at ${this.path}, then retry.`;
  }
  get message(): string {
    return `Invalid Author Workspace metadata at ${this.path}`;
  }
}

export class AuthorWorkspaceAlreadyRegistered
  extends Data.TaggedError("AuthorWorkspaceAlreadyRegistered")<{ workspaceId: string; at: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Use the existing workspace at ${this.at}. If this folder is a copy, remove .skit/workspace.json only in the copy, then register it again for a new identity.`;
  }
  get message(): string {
    return `Author Workspace ${this.workspaceId} is already registered at ${this.at}`;
  }
}

export class InsecureOrigin
  extends Data.TaggedError("InsecureOrigin")<{
    purpose: "authentication" | "author remote";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Use an https:// origin, or http://localhost for local development.";
  get message(): string {
    return this.purpose === "authentication"
      ? "Authentication requires HTTPS outside localhost"
      : "Author remotes require HTTPS outside localhost";
  }
}

export class AuthorDestinationInvalid
  extends Data.TaggedError("AuthorDestinationInvalid")<{
    form: "bare" | "https";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Pass the destination as namespace/skit or https://<registry>/namespace/skit.";
  get message(): string {
    return this.form === "bare"
      ? "Author destination must be namespace/skit"
      : "HTTPS SKIT destination must end in /namespace/skit";
  }
}

export class AuthorDestinationMalformed
  extends Data.TaggedError("AuthorDestinationMalformed")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Pass the destination as namespace/skit or https://<registry>/namespace/skit.";
}

export class AuthorRemoteMetadataInvalid
  extends Data.TaggedError("AuthorRemoteMetadataInvalid")<{
    path: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Correct or remove the author remote metadata at ${this.path}, then retry.`;
  }
  get message(): string {
    return `Author remote metadata at ${this.path} is invalid`;
  }
}

export class LocalFilesChangedDuringSync
  extends Data.TaggedError("LocalFilesChangedDuringSync")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Let local edits finish, then sync again.";
  get message(): string {
    return "Local files changed while sync was running";
  }
}

/** Incoming bytes cannot replace a local path excluded from the captured inventory. */
export class AuthorLocalPathNotObserved
  extends Data.TaggedError("AuthorLocalPathNotObserved")<{ path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "SKIT kept this local path unchanged. Review its ignore rules or move it explicitly before retrying.";
  get message(): string {
    return `Cannot replace local path outside the recorded Author inventory: ${this.path}`;
  }
}

/** Two native names normalize to one target; receiving must not pick one silently. */
export class AuthorNormalizationTwin
  extends Data.TaggedError("AuthorNormalizationTwin")<{
    path: string;
    nativePath: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Keep both files and give them distinct normalized names before retrying.";
  get message(): string {
    return `Normalization twin prevents receiving ${this.path}: ${this.nativePath}`;
  }
}

/** This filesystem cannot reach a non-NFC native entry by its canonical NFC name. */
export class AuthorNonNfcPathUnsupported
  extends Data.TaggedError("AuthorNonNfcPathUnsupported")<{
    path: string;
    nativePath: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Rename the local path to NFC deliberately before receiving updates.";
  get message(): string {
    return `Receiving a non-NFC native path is unsupported on this filesystem: ${this.nativePath}`;
  }
}

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

export class AuthorRemoteAlreadyExists
  extends Data.TaggedError("AuthorRemoteAlreadyExists")<{
    locator: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Sync without --to to use the existing remote home.";
  get message(): string {
    return `Remote home already exists at ${this.locator}`;
  }
}

export class VisibilityNotAccepted
  extends Data.TaggedError("VisibilityNotAccepted")<{
    reason: "already-synced" | "required";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return this.reason === "already-synced"
      ? "Sync again without --visibility."
      : "Pass --visibility private, unlisted or public.";
  }
  get message(): string {
    return this.reason === "already-synced"
      ? "--visibility is accepted only on first author sync"
      : "First author sync requires --visibility";
  }
}

export class DestinationFormInvalid
  extends Data.TaggedError("DestinationFormInvalid")<{
    form: "canonical" | "relative-without-registry";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return this.form === "canonical"
      ? "Pass the destination as skit://host/namespace/skit."
      : "Run `skit auth login`, or pass a full destination.";
  }
  get message(): string {
    return this.form === "canonical"
      ? "Canonical SKIT destination must be skit://host/namespace/skit"
      : "A relative author destination requires an active Registry; run `skit auth login`";
  }
}

export class DestinationExistsWithoutHistory
  extends Data.TaggedError("DestinationExistsWithoutHistory")<{ identity: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Choose a new destination, or sync from a SKIT that shares its history.";
  get message(): string {
    return `Destination ${this.identity} already exists without common history`;
  }
}

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
