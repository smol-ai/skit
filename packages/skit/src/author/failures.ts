import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { PublicationDiagnostic } from "../artifact/validation-diagnostic.js";

export class AuthorWorkspaceMetadataInvalid
  extends Schema.TaggedError<AuthorWorkspaceMetadataInvalid, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceMetadataInvalid",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class AuthorWorkspaceAlreadyRegistered
  extends Schema.TaggedError<AuthorWorkspaceAlreadyRegistered, { readonly brand: unique symbol }>()(
    "AuthorWorkspaceAlreadyRegistered",
    { workspaceId: Schema.String, at: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class InsecureOrigin
  extends Schema.TaggedError<InsecureOrigin, { readonly brand: unique symbol }>()(
    "InsecureOrigin",
    { purpose: Schema.Literals(["authentication", "author remote"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class AuthorDestinationInvalid
  extends Schema.TaggedError<AuthorDestinationInvalid, { readonly brand: unique symbol }>()(
    "AuthorDestinationInvalid",
    { form: Schema.Literals(["bare", "https"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class AuthorDestinationMalformed
  extends Schema.TaggedError<AuthorDestinationMalformed, { readonly brand: unique symbol }>()(
    "AuthorDestinationMalformed",
    { kind: Schema.Literals(["url", "uri-component"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class AuthorRemoteMetadataInvalid
  extends Schema.TaggedError<AuthorRemoteMetadataInvalid, { readonly brand: unique symbol }>()(
    "AuthorRemoteMetadataInvalid",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class LocalFilesChangedDuringSync
  extends Schema.TaggedError<LocalFilesChangedDuringSync, { readonly brand: unique symbol }>()(
    "LocalFilesChangedDuringSync",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class AuthorLocalPathUnchecked
  extends Schema.TaggedError<AuthorLocalPathUnchecked, { readonly brand: unique symbol }>()(
    "AuthorLocalPathUnchecked",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class AuthorNormalizationTwin
  extends Schema.TaggedError<AuthorNormalizationTwin, { readonly brand: unique symbol }>()(
    "AuthorNormalizationTwin",
    { path: Schema.String, nativePath: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class AuthorNonNfcPathUnsupported
  extends Schema.TaggedError<AuthorNonNfcPathUnsupported, { readonly brand: unique symbol }>()(
    "AuthorNonNfcPathUnsupported",
    { path: Schema.String, nativePath: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class NotAnAuthorWorkspace
  extends Schema.TaggedError<NotAnAuthorWorkspace, { readonly brand: unique symbol }>()(
    "NotAnAuthorWorkspace",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class AuthorRemoteAlreadyExists
  extends Schema.TaggedError<AuthorRemoteAlreadyExists, { readonly brand: unique symbol }>()(
    "AuthorRemoteAlreadyExists",
    { locator: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class VisibilityNotAccepted
  extends Schema.TaggedError<VisibilityNotAccepted, { readonly brand: unique symbol }>()(
    "VisibilityNotAccepted",
    { reason: Schema.Literals(["already-synced", "required"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class DestinationFormInvalid
  extends Schema.TaggedError<DestinationFormInvalid, { readonly brand: unique symbol }>()(
    "DestinationFormInvalid",
    { form: Schema.Literals(["canonical", "relative-without-registry"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class DestinationExistsWithoutHistory
  extends Schema.TaggedError<DestinationExistsWithoutHistory, { readonly brand: unique symbol }>()(
    "DestinationExistsWithoutHistory",
    { identity: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class DirectoryAlreadyInLibrary
  extends Schema.TaggedError<DirectoryAlreadyInLibrary, { readonly brand: unique symbol }>()(
    "DirectoryAlreadyInLibrary",
    { collectionId: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class NoRemoteHome
  extends Schema.TaggedError<NoRemoteHome, { readonly brand: unique symbol }>()("NoRemoteHome", {})
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class PublicationBlocked
  extends Schema.TaggedError<PublicationBlocked, { readonly brand: unique symbol }>()(
    "PublicationBlocked",
    {
      reason: Schema.Literals(["content", "assessment"]),
      diagnostics: Schema.Array(PublicationDiagnostic),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class AuthorListIdentityError
  extends Schema.TaggedError<AuthorListIdentityError, { readonly brand: unique symbol }>()(
    "AuthorListIdentityError",
    { identity: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class AuthorDestinationRequired
  extends Schema.TaggedError<AuthorDestinationRequired, { readonly brand: unique symbol }>()(
    "AuthorDestinationRequired",
    { visibilityRequired: Schema.Boolean },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

const authorFailures = Schema.Union([
  AuthorDestinationRequired,
  AuthorWorkspaceMetadataInvalid,
  AuthorWorkspaceAlreadyRegistered,
  InsecureOrigin,
  AuthorDestinationInvalid,
  AuthorDestinationMalformed,
  AuthorRemoteMetadataInvalid,
  LocalFilesChangedDuringSync,
  AuthorLocalPathUnchecked,
  AuthorNormalizationTwin,
  AuthorNonNfcPathUnsupported,
  NotAnAuthorWorkspace,
  AuthorRemoteAlreadyExists,
  VisibilityNotAccepted,
  DestinationFormInvalid,
  DestinationExistsWithoutHistory,
  DirectoryAlreadyInLibrary,
  NoRemoteHome,
  PublicationBlocked,
  AuthorListIdentityError,
]);
export type AuthorFailure = typeof authorFailures.Type;
type EncodedAuthorFailure = typeof authorFailures.Encoded;
export const AuthorFailure: Schema.Codec<AuthorFailure, EncodedAuthorFailure> = authorFailures;
