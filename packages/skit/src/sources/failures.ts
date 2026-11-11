import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class SourceRequired
  extends Schema.TaggedError<SourceRequired, { readonly brand: unique symbol }>()(
    "SourceRequired",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class UnsafeSourceUrl
  extends Schema.TaggedError<UnsafeSourceUrl, { readonly brand: unique symbol }>()(
    "UnsafeSourceUrl",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class InsecureSourceUrl
  extends Schema.TaggedError<InsecureSourceUrl, { readonly brand: unique symbol }>()(
    "InsecureSourceUrl",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class ArchiveEntryLimitExceeded
  extends Schema.TaggedError<ArchiveEntryLimitExceeded, { readonly brand: unique symbol }>()(
    "ArchiveEntryLimitExceeded",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class UnsafeArchivePath
  extends Schema.TaggedError<UnsafeArchivePath, { readonly brand: unique symbol }>()(
    "UnsafeArchivePath",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class SourceNotFound
  extends Schema.TaggedError<SourceNotFound, { readonly brand: unique symbol }>()(
    "SourceNotFound",
    { source: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
}

export class UnsafeGitSubpath
  extends Schema.TaggedError<UnsafeGitSubpath, { readonly brand: unique symbol }>()(
    "UnsafeGitSubpath",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class GitSourceFragment
  extends Schema.TaggedError<GitSourceFragment, { readonly brand: unique symbol }>()(
    "GitSourceFragment",
    { source: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class DirectSkillDocumentInvalid
  extends Schema.TaggedError<DirectSkillDocumentInvalid, { readonly brand: unique symbol }>()(
    "DirectSkillDocumentInvalid",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class NoSkitDescriptorFound
  extends Schema.TaggedError<NoSkitDescriptorFound, { readonly brand: unique symbol }>()(
    "NoSkitDescriptorFound",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class RegistryNotConfigured
  extends Schema.TaggedError<RegistryNotConfigured, { readonly brand: unique symbol }>()(
    "RegistryNotConfigured",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export const SourceFailure = Schema.Union([
  RegistryNotConfigured,
  SourceRequired,
  UnsafeSourceUrl,
  InsecureSourceUrl,
  ArchiveEntryLimitExceeded,
  UnsafeArchivePath,
  SourceNotFound,
  UnsafeGitSubpath,
  GitSourceFragment,
  DirectSkillDocumentInvalid,
  NoSkitDescriptorFound,
]);
export type SourceFailure = typeof SourceFailure.Type;
