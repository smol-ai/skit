import {
  SignInFailed,
  SignOutRejected,
  SignInRejected,
  TooManyAuthAttempts,
  CredentialsUnusable,
  authFailure,
} from "./auth-failures.js";
export {
  SignInFailed,
  SignOutRejected,
  SignInRejected,
  TooManyAuthAttempts,
  CredentialsUnusable,
} from "./auth-failures.js";
import { RegistryResponseFailure, registryResponseDetails } from "./response-failure.js";
// Registry failures carry the facts; the exhaustive formatter below owns their presentation.
// Error.message delegates to that formatter for native-error consumers such as watcher storage.
// The getters contain no separate wording or command policy.
import { FailureTypeId, type SkitFailure, errorMessage } from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { Block } from "../terminal/blocks.js";
import { describeFailure } from "../terminal/failure.js";

export class RegistryUnreachable
  extends Schema.TaggedError<RegistryUnreachable, { readonly brand: unique symbol }>()(
    "RegistryUnreachable",
    {
      origin: Schema.String,
      cause: Schema.ErrorInstance(),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistryOriginInvalid
  extends Schema.TaggedError<RegistryOriginInvalid, { readonly brand: unique symbol }>()(
    "RegistryOriginInvalid",
    {
      origin: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class NoStoredCredentials
  extends Schema.TaggedError<NoStoredCredentials, { readonly brand: unique symbol }>()(
    "NoStoredCredentials",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistrySelectionAmbiguous
  extends Schema.TaggedError<RegistrySelectionAmbiguous, { readonly brand: unique symbol }>()(
    "RegistrySelectionAmbiguous",
    {
      origins: Schema.Array(Schema.String),
      command: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistryAliasInvalid
  extends Schema.TaggedError<RegistryAliasInvalid, { readonly brand: unique symbol }>()(
    "RegistryAliasInvalid",
    {
      alias: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistryAliasConflict
  extends Schema.TaggedError<RegistryAliasConflict, { readonly brand: unique symbol }>()(
    "RegistryAliasConflict",
    {
      alias: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistryAliasNotFound
  extends Schema.TaggedError<RegistryAliasNotFound, { readonly brand: unique symbol }>()(
    "RegistryAliasNotFound",
    {
      alias: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistrySelectionConflict
  extends Schema.TaggedError<RegistrySelectionConflict, { readonly brand: unique symbol }>()(
    "RegistrySelectionConflict",
    {
      locator: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistrySelectionRequiresRegistrySource
  extends Schema.TaggedError<
    RegistrySelectionRequiresRegistrySource,
    { readonly brand: unique symbol }
  >()("RegistrySelectionRequiresRegistrySource", {
    source: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RemoteSkitUnavailable
  extends Schema.TaggedError<RemoteSkitUnavailable, { readonly brand: unique symbol }>()(
    "RemoteSkitUnavailable",
    {
      identity: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class LibraryChangedOnServer
  extends Schema.TaggedError<LibraryChangedOnServer, { readonly brand: unique symbol }>()(
    "LibraryChangedOnServer",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class AuthenticationRequired
  extends Schema.TaggedError<AuthenticationRequired, { readonly brand: unique symbol }>()(
    "AuthenticationRequired",
    {
      origin: Schema.optionalKey(Schema.String),
      scopes: Schema.optionalKey(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "AUTHENTICATION_REQUIRED" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class CredentialLacksScope
  extends Schema.TaggedError<CredentialLacksScope, { readonly brand: unique symbol }>()(
    "CredentialLacksScope",
    {
      scope: Schema.String,
      origin: Schema.optionalKey(Schema.String),
      scopes: Schema.optionalKey(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "AUTHENTICATION_REQUIRED" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class PrincipalNotAuthorized
  extends Schema.TaggedError<PrincipalNotAuthorized, { readonly brand: unique symbol }>()(
    "PrincipalNotAuthorized",
    {
      action: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class InteractiveLoginUnavailable
  extends Schema.TaggedError<InteractiveLoginUnavailable, { readonly brand: unique symbol }>()(
    "InteractiveLoginUnavailable",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class DeviceLoginUnavailable
  extends Schema.TaggedError<DeviceLoginUnavailable, { readonly brand: unique symbol }>()(
    "DeviceLoginUnavailable",
    {
      origin: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class DeviceLoginEnded
  extends Schema.TaggedError<DeviceLoginEnded, { readonly brand: unique symbol }>()(
    "DeviceLoginEnded",
    {
      reason: Schema.Literals(["denied", "expired", "invalid"]),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class ScopesInvalid
  extends Schema.TaggedError<ScopesInvalid, { readonly brand: unique symbol }>()("ScopesInvalid", {
    allowed: Schema.Array(Schema.String),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class AuthorSyncRequired
  extends Schema.TaggedError<AuthorSyncRequired, { readonly brand: unique symbol }>()(
    "AuthorSyncRequired",
    {
      root: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class RegistryRejectedWrite
  extends Schema.TaggedError<RegistryRejectedWrite, { readonly brand: unique symbol }>()(
    "RegistryRejectedWrite",
    RegistryResponseFailure.fields,
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export class DeleteRequiresPrivate
  extends Schema.TaggedError<DeleteRequiresPrivate, { readonly brand: unique symbol }>()(
    "DeleteRequiresPrivate",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  override get message(): string {
    return registryFailure(this).message;
  }
}

export const RegistryFailure = Schema.Union([
  RegistryUnreachable,
  RegistryOriginInvalid,
  NoStoredCredentials,
  RegistrySelectionAmbiguous,
  TooManyAuthAttempts,
  SignInFailed,
  SignOutRejected,
  RegistryAliasInvalid,
  RegistryAliasConflict,
  RegistryAliasNotFound,
  RegistrySelectionConflict,
  RegistrySelectionRequiresRegistrySource,
  RemoteSkitUnavailable,
  LibraryChangedOnServer,
  AuthenticationRequired,
  CredentialLacksScope,
  PrincipalNotAuthorized,
  CredentialsUnusable,
  SignInRejected,
  InteractiveLoginUnavailable,
  DeviceLoginUnavailable,
  DeviceLoginEnded,
  ScopesInvalid,
  AuthorSyncRequired,
  RegistryRejectedWrite,
  DeleteRequiresPrivate,
]);
export type RegistryFailure = typeof RegistryFailure.Type;

/** Keep a suggested shell argument intact, including spaces, quotes and metacharacters. */
const commandArgument = (value: string) =>
  /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const loginCommand = (origin?: string, scopes?: string) =>
  `skit auth login${origin ? ` ${commandArgument(origin)}` : ""}${scopes ? ` --scopes ${commandArgument(scopes)}` : ""}`;

export const registryFailure = (failure: RegistryFailure) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      RegistryUnreachable: ({ origin, cause }) =>
        describeFailure({
          summary: ["Unable to reach Registry ", { code: origin }],
          details: [Block.Note({ text: [errorMessage(cause)] })],
          next: ["Check the network connection and the Registry origin, then retry."],
        }),
      RegistryOriginInvalid: ({ origin }) =>
        describeFailure({
          summary: ["Invalid Registry URL: ", { code: origin }],
          next: [
            "Pass the Registry as a full URL, such as ",
            { code: "https://registry.example.com" },
            ".",
          ],
        }),
      NoStoredCredentials: () =>
        describeFailure({
          summary: ["No stored SKIT authentication to revoke"],
          next: [
            "Run ",
            { code: "skit auth status" },
            " to see which Registries hold a stored credential.",
          ],
        }),
      RegistrySelectionAmbiguous: ({ origins, command }) =>
        describeFailure({
          summary: ["Registry selection is ambiguous"],
          details: [Block.List({ items: origins.map((origin) => ({ text: [{ code: origin }] })) })],
          next: ["Run ", { code: command }, " to choose one Registry."],
        }),
      TooManyAuthAttempts: authFailure,
      SignInFailed: authFailure,
      SignOutRejected: authFailure,
      RegistryAliasInvalid: ({ alias }) =>
        describeFailure({
          summary: ["Invalid Registry name: ", { code: alias }],
          next: ["Use a name of lowercase letters, digits and hyphens that starts with a letter."],
        }),
      RegistryAliasConflict: ({ alias }) =>
        describeFailure({
          summary: ["Registry name already exists: ", { code: alias }],
          next: [
            "Choose another name, or run ",
            { code: `skit registry remove ${commandArgument(alias)}` },
            " first.",
          ],
        }),
      RegistryAliasNotFound: ({ alias }) =>
        describeFailure({
          summary: ["Unknown Registry name: ", { code: alias }],
          next: ["Run ", { code: "skit registry list" }, " to see the configured Registry names."],
        }),
      RegistrySelectionConflict: ({ locator }) =>
        describeFailure({
          summary: [
            "A concrete Registry locator cannot be combined with ",
            { code: "--registry" },
            ": ",
            { code: locator },
          ],
          next: [
            "Pass either the concrete Registry locator or ",
            { code: "--registry" },
            ", not both.",
          ],
        }),
      RegistrySelectionRequiresRegistrySource: ({ source }) =>
        describeFailure({
          summary: [{ code: "--registry" }, " requires a Registry source: ", { code: source }],
          next: [
            "Use ",
            { code: "--registry" },
            " only with a Registry source such as ",
            { code: "namespace/skit" },
            ".",
          ],
        }),
      RemoteSkitUnavailable: ({ identity }) =>
        describeFailure({
          summary: ["Remote SKIT ", { code: identity }, " is unavailable"],
          next: [
            "Check that the SKIT still exists and that the active credential can read it, then retry.",
          ],
        }),
      LibraryChangedOnServer: () =>
        describeFailure({
          summary: ["Library changed on the server"],
          next: ["Run ", { code: "skit sync" }, " again."],
        }),
      AuthenticationRequired: ({ origin, scopes }) =>
        describeFailure({
          summary: ["Authentication is required"],
          next: ["Run ", { code: loginCommand(origin, scopes) }, ", then retry."],
        }),
      CredentialLacksScope: ({ scope, origin, scopes }) =>
        describeFailure({
          summary: ["The active credential lacks ", { code: scope }],
          next: ["Run ", { code: loginCommand(origin, scopes ?? scope) }, ", then retry."],
        }),
      PrincipalNotAuthorized: ({ action }) =>
        describeFailure({
          summary: [`The active Principal is not authorized to ${action}`],
          next: [
            "Sign in as a Principal with access, or ask an owner of the Namespace to grant it.",
          ],
        }),
      CredentialsUnusable: authFailure,
      SignInRejected: authFailure,
      InteractiveLoginUnavailable: () =>
        describeFailure({
          summary: ["Login needs a person to sign in"],
          next: [
            "Run ",
            { code: "skit auth login" },
            " in a terminal, or set ",
            { code: "SKIT_TOKEN" },
            " to use an existing credential.",
          ],
        }),
      DeviceLoginUnavailable: ({ origin }) =>
        describeFailure({
          summary: [{ code: origin }, " does not offer browser approval for CLI login"],
          next: [
            "Run ",
            { code: "skit auth login" },
            " in a terminal to sign in with email and password.",
          ],
        }),
      DeviceLoginEnded: ({ reason }) =>
        describeFailure({
          summary: [
            reason === "denied"
              ? "The login was denied in the browser"
              : reason === "invalid"
                ? "The login code is invalid or was already used"
                : "The login code expired before it was approved",
          ],
          next: ["Run ", { code: "skit auth login" }, " again for a new code."],
        }),
      ScopesInvalid: ({ allowed }) =>
        describeFailure({
          summary: [{ code: "--scopes" }, " must contain only the allowed scopes"],
          details: [Block.List({ items: allowed.map((scope) => ({ text: [{ code: scope }] })) })],
          next: ["Pass ", { code: "--scopes" }, " using only the allowed scopes."],
        }),
      AuthorSyncRequired: ({ root }) =>
        describeFailure({
          summary: ["Local files do not match the current Registry revision"],
          next: [
            "Run ",
            { code: `skit author sync ${commandArgument(root)} --apply` },
            ", then publish again.",
          ],
        }),
      RegistryRejectedWrite: (failure) =>
        describeFailure({
          summary: ["The Registry rejected the publication write"],
          details: registryResponseDetails(failure),
          next: ["Address the Registry's reason, then retry."],
        }),
      DeleteRequiresPrivate: () =>
        describeFailure({
          summary: [
            "Only a fully private SKIT can be deleted; public or unlisted SKITs require a separate lifecycle operation",
          ],
          next: ["Delete only a fully private SKIT; public and unlisted SKITs stay published."],
        }),
    }),
  );

export { PublicationBlocked, DestinationExistsWithoutHistory } from "@smolai/skit-core/author";
