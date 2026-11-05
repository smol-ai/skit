import { Data } from "effect";
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
