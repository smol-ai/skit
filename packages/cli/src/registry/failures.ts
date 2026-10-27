// Named failures for talking to a Registry: credentials, Registry selection, author
// destinations, and Draft sync.
//
// These were seventeen SkitError sites across four codes. The conditions are genuinely distinct —
// an expired race against the server is not a malformed destination — and callers that want to
// retry, re-authenticate or re-resolve need to tell them apart.

import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";

export class NotBoundToRegistry
  extends Data.TaggedError("NotBoundToRegistry")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Run `skit author sync --to <namespace/skit>` to give this SKIT a remote home.";
  get message(): string {
    return "This SKIT is not bound to a Registry";
  }
}

/** The Registry could not be reached at all; nothing it would have said is known. */
export class RegistryUnreachable
  extends Data.TaggedError("RegistryUnreachable")<{
    origin: string;
    cause: Error;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the network connection and the Registry origin, then retry.";
  get message(): string {
    return `Unable to reach Registry ${this.origin}: ${this.cause.message}`;
  }
}

// -- Credentials --------------------------------------------------------------------------------

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

export class RegistryOriginInvalid
  extends Data.TaggedError("RegistryOriginInvalid")<{
    origin: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Pass the Registry as a full URL, such as https://registry.example.com.";
  get message(): string {
    return `Invalid Registry URL: ${this.origin}`;
  }
}

export class NoStoredCredentials
  extends Data.TaggedError("NoStoredCredentials")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Run `skit auth status` to see which Registries hold a stored credential.";
  get message(): string {
    return "No stored SKIT authentication to revoke";
  }
}

export class RegistrySelectionAmbiguous
  extends Data.TaggedError("RegistrySelectionAmbiguous")<{
    origins: readonly string[];
    command: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Run \`${this.command}\` to choose one Registry.`;
  }
  get message(): string {
    return `Registry selection is ambiguous (${this.origins.join(", ")}); run \`${this.command}\``;
  }
}

export class TooManyAuthAttempts
  extends Data.TaggedError("TooManyAuthAttempts")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Wait one minute, then retry.";
  get message(): string {
    return "Too many authentication attempts; wait one minute and retry";
  }
}

/**
 * Sign-in got far enough to say something specific, and the sentence is the value.
 *
 * These were bare `throw new Error(...)` before the conversion, so they classify as
 * OPERATION_FAILED exactly as they did.
 */
export class SignInFailed
  extends Data.TaggedError("SignInFailed")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Check the Registry origin and requested scopes, then run `skit auth login` again.";
}

export class SignOutRejected
  extends Data.TaggedError("SignOutRejected")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Run `skit auth logout` again; if it keeps failing, revoke the credential at the Registry.";
}

// -- Registry selection ---------------------------------------------------------------------------

export class RegistryAliasInvalid
  extends Data.TaggedError("RegistryAliasInvalid")<{
    name: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Use a name of lowercase letters, digits and hyphens that starts with a letter.";
  get message() {
    return `Invalid Registry name: ${this.name}`;
  }
}

export class RegistryAliasConflict
  extends Data.TaggedError("RegistryAliasConflict")<{
    name: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Choose another name, or run \`skit registry remove ${this.name}\` first.`;
  }
  get message() {
    return `Registry name already exists: ${this.name}`;
  }
}

export class RegistryAliasNotFound
  extends Data.TaggedError("RegistryAliasNotFound")<{
    name: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Run `skit registry list` to see the configured Registry names.";
  get message() {
    return `Unknown Registry name: ${this.name}`;
  }
}

export class RegistrySelectionConflict
  extends Data.TaggedError("RegistrySelectionConflict")<{
    locator: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Pass either the concrete Registry locator or --registry, not both.";
  get message(): string {
    return `A concrete Registry locator cannot be combined with --registry: ${this.locator}`;
  }
}

export class RegistrySelectionRequiresRegistrySource
  extends Data.TaggedError("RegistrySelectionRequiresRegistrySource")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Use --registry only with a Registry source such as namespace/skit.";
  get message(): string {
    return `--registry requires a Registry source: ${this.source}`;
  }
}

// -- Author destinations ------------------------------------------------------------------------

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

export class NoAuthorRemote extends Data.TaggedError("NoAuthorRemote")<{}> implements SkitFailure {
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run `skit author sync --to <namespace/skit>` to configure one.";
  get message(): string {
    return "No author remote is configured";
  }
}

// -- Draft synchronization ----------------------------------------------------------------------

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

export class SyncBlockedByValidation
  extends Data.TaggedError("SyncBlockedByValidation")<{
    stage: "local" | "merged";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Correct the reported validation diagnostics, then sync again.";
  get message(): string {
    return this.stage === "local"
      ? "Sync is blocked until the local SKIT validates"
      : "The merged SKIT does not validate";
  }
}

export class RemoteDraftUnavailable
  extends Data.TaggedError("RemoteDraftUnavailable")<{
    identity: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation =
    "Check that the Draft still exists and that the active credential can read it, then retry.";
  get message(): string {
    return `Remote Draft ${this.identity} is unavailable`;
  }
}

export class RemoteDraftIdentityMismatch
  extends Data.TaggedError("RemoteDraftIdentityMismatch")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Check the author remote's Registry and destination, then retry.";
  get message(): string {
    return "Remote Draft identity does not match its Registry route";
  }
}

/** Someone edited the working tree while a sync was in flight. */
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

/** The Library moved underneath a synchronization that had already planned against it. */
export class LibraryChangedOnServer
  extends Data.TaggedError("LibraryChangedOnServer")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run `skit sync` again.";
  get message(): string {
    return "Library changed on the server; synchronize again";
  }
}

// -- Credentials and scopes ----------------------------------------------------------------------
//
// Fourteen sites across six modules said one of three things: sign in, sign in with more scopes,
// or you are not the right Principal. They differed only in which origin and scopes to name, so
// those are fields.

export class AuthenticationRequired
  extends Data.TaggedError("AuthenticationRequired")<{
    origin?: string;
    scopes?: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "AUTHENTICATION_REQUIRED" as const;
  get remediation(): string {
    const scopes = this.scopes ? ` --scopes ${this.scopes}` : "";
    return `Run \`skit auth login${this.origin ? ` ${this.origin}` : ""}${scopes}\`, then retry.`;
  }
  get message(): string {
    const scopes = this.scopes ? ` --scopes ${this.scopes}` : "";
    return `Authentication is required; run \`skit auth login${this.origin ? ` ${this.origin}` : ""}${scopes}\``;
  }
}

export class CredentialLacksScope
  extends Data.TaggedError("CredentialLacksScope")<{
    scope: string;
    origin?: string;
    scopes?: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "AUTHENTICATION_REQUIRED" as const;
  get remediation(): string {
    return `Run \`skit auth login${this.origin ? ` ${this.origin}` : ""} --scopes ${this.scopes ?? this.scope}\`, then retry.`;
  }
  get message(): string {
    return `The active credential lacks ${this.scope}; run \`skit auth login${this.origin ? ` ${this.origin}` : ""} --scopes ${this.scopes ?? this.scope}\``;
  }
}

export class PrincipalNotAuthorized
  extends Data.TaggedError("PrincipalNotAuthorized")<{
    action: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    "Sign in as a Principal with access, or ask an owner of the Namespace to grant it.";
  get message(): string {
    return `The active Principal is not authorized to ${this.action}`;
  }
}

export class CredentialsUnusable
  extends Data.TaggedError("CredentialsUnusable")<{
    path: string;
    reason: "unreadable" | "invalid";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return this.reason === "unreadable"
      ? `Fix the permissions on ${this.path}, then retry.`
      : `Move ${this.path} aside, then run \`skit auth login\` again.`;
  }
  get message(): string {
    return this.reason === "unreadable"
      ? `Cannot read SKIT authentication configuration at ${this.path}; fix its permissions`
      : `SKIT authentication configuration at ${this.path} is invalid; move it aside and log in again`;
  }
}

export class SignInRejected
  extends Data.TaggedError("SignInRejected")<{ context: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    // The Registry does not say why, so as not to reveal which accounts exist or how they sign in.
    return this.context === "Sign in"
      ? "Check the email and password, then retry. An account created with GitHub sign-in has no password, so it cannot sign in from the CLI yet."
      : "Run `skit auth login` again.";
  }
  get message(): string {
    return this.context === "Sign in"
      ? "Email or password is incorrect"
      : `${this.context} was unauthorized; run \`skit auth login\` again`;
  }
}

export class InteractiveLoginUnavailable
  extends Data.TaggedError("InteractiveLoginUnavailable")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run `skit auth login` in a terminal, or set SKIT_TOKEN.";
  get message(): string {
    return "Login needs a person to sign in; set SKIT_TOKEN to use an existing credential";
  }
}

/** The Registry predates browser approval, so only email and password sign-in remain. */
export class DeviceLoginUnavailable
  extends Data.TaggedError("DeviceLoginUnavailable")<{ origin: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run `skit auth login` in a terminal to sign in with email and password.";
  get message(): string {
    return `${this.origin} does not offer browser approval for CLI login`;
  }
}

export class DeviceLoginEnded
  extends Data.TaggedError("DeviceLoginEnded")<{ reason: "denied" | "expired" }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Run `skit auth login` again for a new code.";
  get message(): string {
    return this.reason === "denied"
      ? "The login was denied in the browser"
      : "The login code expired before it was approved";
  }
}

export class ScopesInvalid
  extends Data.TaggedError("ScopesInvalid")<{
    allowed: readonly string[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  get remediation(): string {
    return `Pass --scopes with only ${this.allowed.join(", ")}.`;
  }
  get message(): string {
    return `--scopes must contain only: ${this.allowed.join(", ")}`;
  }
}

// -- Publication ------------------------------------------------------------------------------------

export class NoRemoteHome extends Data.TaggedError("NoRemoteHome")<{}> implements SkitFailure {
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Run `skit author sync --to <namespace/skit>` first.";
  get message(): string {
    return "This SKIT has no remote home; run `skit author sync --to ...` first";
  }
}

/** The configured Registry is not the one this SKIT is bound to. */
export class RegistryMismatch
  extends Data.TaggedError("RegistryMismatch")<{
    active: string;
    expected: string;
    subject: "remote home" | "author destination";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Sign in to ${this.expected} with \`skit auth login ${this.expected}\`, then retry.`;
  }
  get message(): string {
    return `Active Registry ${this.active} does not match ${this.subject} ${this.expected}`;
  }
}

export class PublicationBlocked
  extends Data.TaggedError("PublicationBlocked")<{
    reason: "content" | "assessment";
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
  readonly remediation = "Resolve the reported findings, sync the Draft, then publish again.";
  get message(): string {
    return this.reason === "content"
      ? `This SKIT cannot be published as it stands:\n${this.detail}`
      : `Publication is blocked by the current Draft assessment${this.detail}`;
  }
}

export class DraftOutOfSync
  extends Data.TaggedError("DraftOutOfSync")<{ commandPath: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get remediation(): string {
    return `Run \`skit author sync ${this.commandPath} --apply\`, then publish again.`;
  }
  get message(): string {
    return `Local files do not match the current Draft; run \`skit author sync ${this.commandPath} --apply\` before publishing`;
  }
}

/** The Registry refused the write, with whatever it said. */
export class RegistryRejectedWrite
  extends Data.TaggedError("RegistryRejectedWrite")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Address the Registry's reason, then retry.";
  get message(): string {
    return this.detail;
  }
}

export class DeleteRequiresPrivate
  extends Data.TaggedError("DeleteRequiresPrivate")<{}>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation =
    "Delete only a fully private SKIT; public and unlisted SKITs stay published.";
  get message(): string {
    return "Only a fully private SKIT can be deleted; public or unlisted SKITs require a separate lifecycle operation";
  }
}

// -- Draft destinations ------------------------------------------------------------------------------

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

export class DraftSlugMismatch
  extends Data.TaggedError("DraftSlugMismatch")<{
    context: string;
    remote: string;
    local: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Use a destination whose slug matches the local SKIT, then retry.";
  get message(): string {
    return `${this.context} SKIT slug ${this.remote} does not match local slug ${this.local}`;
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
