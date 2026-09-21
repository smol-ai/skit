// Named failures for talking to a Registry: credentials, author destinations, and Draft sync.
//
// These were seventeen SkitError sites across four codes. The conditions are genuinely distinct —
// an expired race against the server is not a malformed destination — and callers that want to
// retry, re-authenticate or re-resolve need to tell them apart.

import { Data } from "effect";

export class NotBoundToRegistry extends Data.TaggedError("NotBoundToRegistry")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "This SKIT is not bound to a Registry";
  }
}

// -- Credentials --------------------------------------------------------------------------------

export class InsecureOrigin extends Data.TaggedError("InsecureOrigin")<{
  purpose: "authentication" | "author remote";
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.purpose === "authentication"
      ? "Authentication requires HTTPS outside localhost"
      : "Author remotes require HTTPS outside localhost";
  }
}

export class RegistryOriginInvalid extends Data.TaggedError("RegistryOriginInvalid")<{
  origin: string;
}> {
  get message(): string {
    return `Invalid Registry URL: ${this.origin}`;
  }
}

export class NoStoredCredentials extends Data.TaggedError("NoStoredCredentials")<{}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return "No stored SKIT authentication to revoke";
  }
}

export class RegistrySelectionAmbiguous extends Data.TaggedError("RegistrySelectionAmbiguous")<{
  origins: readonly string[];
  command: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Registry selection is ambiguous (${this.origins.join(", ")}); run \`${this.command}\``;
  }
}

export class TooManyAuthAttempts extends Data.TaggedError("TooManyAuthAttempts")<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Too many authentication attempts; wait one minute and retry";
  }
}

// -- Author destinations ------------------------------------------------------------------------

export class AuthorDestinationInvalid extends Data.TaggedError("AuthorDestinationInvalid")<{
  form: "bare" | "https";
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.form === "bare"
      ? "Author destination must be namespace/skit"
      : "HTTPS SKIT destination must end in /namespace/skit";
  }
}

export class AuthorDestinationMalformed extends Data.TaggedError("AuthorDestinationMalformed")<{
  message: string;
}> {}

export class AuthorRemoteMetadataInvalid extends Data.TaggedError("AuthorRemoteMetadataInvalid")<{
  path: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Author remote metadata at ${this.path} is invalid`;
  }
}

export class AuthorRemoteAlreadyExists extends Data.TaggedError("AuthorRemoteAlreadyExists")<{
  locator: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Remote home already exists at ${this.locator}`;
  }
}

export class NoAuthorRemote extends Data.TaggedError("NoAuthorRemote")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "No author remote is configured";
  }
}

// -- Draft synchronization ----------------------------------------------------------------------

export class VisibilityNotAccepted extends Data.TaggedError("VisibilityNotAccepted")<{
  reason: "already-synced" | "required";
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.reason === "already-synced"
      ? "--visibility is accepted only on first author sync"
      : "First author sync requires --visibility";
  }
}

export class SyncBlockedByValidation extends Data.TaggedError("SyncBlockedByValidation")<{
  stage: "local" | "merged";
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return this.stage === "local"
      ? "Sync is blocked until the local SKIT validates"
      : "The merged SKIT does not validate";
  }
}

export class RemoteDraftUnavailable extends Data.TaggedError("RemoteDraftUnavailable")<{
  identity: string;
}> {
  readonly code = "NOT_FOUND" as const;
  get message(): string {
    return `Remote Draft ${this.identity} is unavailable`;
  }
}

export class RemoteDraftIdentityMismatch extends Data.TaggedError(
  "RemoteDraftIdentityMismatch",
)<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Remote Draft identity does not match its Registry route";
  }
}

/** Someone edited the working tree while a sync was in flight. */
export class LocalFilesChangedDuringSync extends Data.TaggedError(
  "LocalFilesChangedDuringSync",
)<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Local files changed while sync was running";
  }
}

/** The Library moved underneath a synchronization that had already planned against it. */
export class LibraryChangedOnServer extends Data.TaggedError("LibraryChangedOnServer")<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Library changed on the server; synchronize again";
  }
}

// -- Credentials and scopes ----------------------------------------------------------------------
//
// Fourteen sites across six modules said one of three things: sign in, sign in with more scopes,
// or you are not the right Principal. They differed only in which origin and scopes to name, so
// those are fields.

export class AuthenticationRequired extends Data.TaggedError("AuthenticationRequired")<{
  origin?: string;
  scopes?: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    const scopes = this.scopes ? ` --scopes ${this.scopes}` : "";
    return `Authentication is required; run \`skit auth login ${this.origin ?? "<origin>"}${scopes}\``;
  }
}

export class CredentialLacksScope extends Data.TaggedError("CredentialLacksScope")<{
  scope: string;
  origin?: string;
  scopes?: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `The active credential lacks ${this.scope}; run \`skit auth login ${this.origin ?? "<origin>"} --scopes ${this.scopes ?? this.scope}\``;
  }
}

export class PrincipalNotAuthorized extends Data.TaggedError("PrincipalNotAuthorized")<{
  action: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `The active Principal is not authorized to ${this.action}`;
  }
}

export class CredentialsUnusable extends Data.TaggedError("CredentialsUnusable")<{
  path: string;
  reason: "unreadable" | "invalid";
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return this.reason === "unreadable"
      ? `Cannot read SKIT authentication configuration at ${this.path}; fix its permissions`
      : `SKIT authentication configuration at ${this.path} is invalid; move it aside and log in again`;
  }
}

export class SignInRejected extends Data.TaggedError("SignInRejected")<{ context: string }> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.context === "Sign in"
      ? "Email or password is incorrect"
      : `${this.context} was unauthorized; run \`skit auth login <origin>\` again`;
  }
}

export class InteractiveLoginUnavailable extends Data.TaggedError(
  "InteractiveLoginUnavailable",
)<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "Interactive login requires a terminal; set SKIT_TOKEN to use an existing credential";
  }
}

export class ScopesInvalid extends Data.TaggedError("ScopesInvalid")<{
  allowed: readonly string[];
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return `--scopes must contain only: ${this.allowed.join(", ")}`;
  }
}

// -- Publication ------------------------------------------------------------------------------------

export class NoRemoteHome extends Data.TaggedError("NoRemoteHome")<{}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return "This SKIT has no remote home; run `skit author sync --to ...` first";
  }
}

/** The configured Registry is not the one this SKIT is bound to. */
export class RegistryMismatch extends Data.TaggedError("RegistryMismatch")<{
  active: string;
  expected: string;
  subject: "remote home" | "author destination";
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Active Registry ${this.active} does not match ${this.subject} ${this.expected}`;
  }
}

export class PublicationBlocked extends Data.TaggedError("PublicationBlocked")<{
  reason: "content" | "assessment";
  detail: string;
}> {
  readonly code = "VALIDATION_FAILED" as const;
  get message(): string {
    return this.reason === "content"
      ? `This SKIT cannot be published as it stands:\n${this.detail}`
      : `Publication is blocked by the current Draft assessment${this.detail}`;
  }
}

export class DraftOutOfSync extends Data.TaggedError("DraftOutOfSync")<{ commandPath: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Local files do not match the current Draft; run \`skit author sync ${this.commandPath} --apply\` before publishing`;
  }
}

/** The Registry refused the write, with whatever it said. */
export class RegistryRejectedWrite extends Data.TaggedError("RegistryRejectedWrite")<{
  detail: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return this.detail;
  }
}

export class DeleteRequiresPrivate extends Data.TaggedError("DeleteRequiresPrivate")<{}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return "Only a fully private SKIT can be deleted; public or unlisted SKITs require a separate lifecycle operation";
  }
}

// -- Draft destinations ------------------------------------------------------------------------------

export class DestinationFormInvalid extends Data.TaggedError("DestinationFormInvalid")<{
  form: "canonical" | "relative-without-registry";
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    return this.form === "canonical"
      ? "Canonical SKIT destination must be skit://host/namespace/skit"
      : "A relative author destination requires an active Registry; run `skit auth login <origin>`";
  }
}

export class DraftSlugMismatch extends Data.TaggedError("DraftSlugMismatch")<{
  context: string;
  remote: string;
  local: string;
}> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `${this.context} SKIT slug ${this.remote} does not match local slug ${this.local}`;
  }
}

export class DestinationExistsWithoutHistory extends Data.TaggedError(
  "DestinationExistsWithoutHistory",
)<{ identity: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `Destination ${this.identity} already exists without common history`;
  }
}

// -- Library synchronization conflicts -----------------------------------------------------------------

export class TakeRemoteInvalid extends Data.TaggedError("TakeRemoteInvalid")<{
  reason: "wildcard" | "binding" | "malformed" | "not-entry" | "no-three-way";
  key?: string;
}> {
  readonly code = "INVALID_ARGUMENT" as const;
  get message(): string {
    switch (this.reason) {
      case "wildcard":
        return "--take-remote requires explicit Entry conflict keys; wildcards and `all` are not allowed";
      case "binding":
        return "Binding conflicts are resolved with `skit enable` or `skit disable`, not --take-remote";
      case "malformed":
        return "--take-remote values must be explicit `entry:<collection-ref>` conflict keys";
      case "not-entry":
        return `${this.key} is not an ordinary Entry conflict and cannot be resolved with --take-remote`;
      default:
        return "--take-remote requires a current three-way Entry conflict; run `skit sync` to review fresh conflicts";
    }
  }
}

export class ConflictKeyStale extends Data.TaggedError("ConflictKeyStale")<{ key: string }> {
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `${this.key} is not a current Library conflict; run \`skit sync\` to review fresh conflicts`;
  }
}
