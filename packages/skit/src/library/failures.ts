import { CollectionVersionArchiveInvalid } from "./snapshot-archive-universal.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { Schema } from "effect";
import { TreeErrorReason } from "../shared/tree-error.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

export class ContentAddressCollision
  extends Schema.TaggedError<ContentAddressCollision, { readonly brand: unique symbol }>()(
    "ContentAddressCollision",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

/** A Manage selection the Library cannot carry out, and why. Front ends write the words. */
export class ManageSelectionInvalid
  extends Schema.TaggedError<ManageSelectionInvalid, { readonly brand: unique symbol }>()(
    "Library.ManageSelectionInvalid",
    {
      skillName: Schema.String,
      reason: Schema.Literals([
        "duplicate-selection",
        "candidate-not-manageable",
        "machine-identity-missing",
      ]),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

/**
 * Steps setup could not run safely, refused before anything is written. `step` counts from zero;
 * `path` is the folder the reason is about. Front ends write the words.
 */
export class SetupStepsInvalid
  extends Schema.TaggedError<SetupStepsInvalid, { readonly brand: unique symbol }>()(
    "Library.SetupStepsInvalid",
    {
      reason: Schema.Literals([
        "sync-program-missing",
        "import-step-missing",
        "removal-not-last",
        "path-not-normalized",
        "path-in-library-storage",
        "duplicate-removal",
        "undo-path-not-replaceable",
      ]),
      step: Schema.optionalKey(Schema.Int),
      path: Schema.optionalKey(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

// -- Library ownership ---------------------------------------------------------------------------

export class UnknownInstalledSkill
  extends Schema.TaggedError<UnknownInstalledSkill, { readonly brand: unique symbol }>()(
    "UnknownInstalledSkill",
    { query: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
}

export class SecurityFindingAbsent
  extends Schema.TaggedError<SecurityFindingAbsent, { readonly brand: unique symbol }>()(
    "SecurityFindingAbsent",
    { fingerprint: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class AcceptanceIncomplete
  extends Schema.TaggedError<AcceptanceIncomplete, { readonly brand: unique symbol }>()(
    "AcceptanceIncomplete",
    { reason: Schema.Literals(["missing", "invalid-expiry", "expiry-in-past"]) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

/** Why selected content cannot supply an author policy or initialized Library. */
export const ImportContentInvalidReason = Schema.TaggedUnion({
  SelectedSkillsMissing: {},
  BackingMissing: { skillName: Schema.String },
  ContentChanged: { kind: Schema.Literals(["collection", "skill"]), skillName: Schema.String },
  DescriptorSkillMissing: { skillName: Schema.String },
});
export type ImportContentInvalidReason = typeof ImportContentInvalidReason.Type;

export class ImportContentInvalid
  extends Schema.TaggedError<ImportContentInvalid, { readonly brand: unique symbol }>()(
    "ImportContentInvalid",
    { reason: ImportContentInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

/** Why something the Library stores cannot be used. Front ends write the words. */
export const InvalidLibraryStateReason = Schema.TaggedUnion({
  SchemaInvalid: { failure: SchemaFailure },
  ArchiveInvalid: { failure: CollectionVersionArchiveInvalid },
  /** It does not decode. `issue` is what the decoder or reader reported, where there is one. */
  InvalidData: {
    issue: Schema.optionalKey(Schema.String),
    tree: Schema.optionalKey(TreeErrorReason),
  },
  /** Its schema version is absent or outside `oldest` to `current`. */
  UnsupportedVersion: {
    version: Schema.optionalKey(Schema.Finite),
    oldest: Schema.Int,
    current: Schema.Int,
  },
  /** A record another record depends on is absent. `at` is the step or path it was expected at. */
  MissingRecord: {
    record: Schema.Literals([
      "pending-operation",
      "sync-step",
      "sync-program",
      "imported-collection",
      "folder-evidence",
      "installed-row",
      "library-state",
    ]),
    at: Schema.optionalKey(Schema.String),
  },
  /** Stored content no longer matches its hash. `entry` names it, where one entry is at fault. */
  ContentChanged: { entry: Schema.optionalKey(Schema.String) },
  /** Stored content a manifest names is absent. */
  ContentMissing: { entry: Schema.String },
  /** A directory the Library owns is a link to somewhere else. */
  InvalidSymlink: {},
});
export type InvalidLibraryStateReason = typeof InvalidLibraryStateReason.Type;

/** Something the Library stores at `path` cannot be used, and why. */
export class InvalidLibraryState
  extends Schema.TaggedError<InvalidLibraryState, { readonly brand: unique symbol }>()(
    "InvalidLibraryState",
    {
      path: Schema.String,
      reason: InvalidLibraryStateReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

/** The Library moved on since the state a change was planned from; nothing was saved. */
export class LibraryChanged
  extends Schema.TaggedError<LibraryChanged, { readonly brand: unique symbol }>()(
    "LibraryChanged",
    { path: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class AddNoSkills
  extends Schema.TaggedError<AddNoSkills, { readonly brand: unique symbol }>()(
    "Library.AddNoSkills",
    { source: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class LibrarySubjectNotFound
  extends Schema.TaggedError<LibrarySubjectNotFound, { readonly brand: unique symbol }>()(
    "Library.SubjectNotFound",
    { query: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
}

export class LibrarySubjectAmbiguous
  extends Schema.TaggedError<LibrarySubjectAmbiguous, { readonly brand: unique symbol }>()(
    "Library.SubjectAmbiguous",
    { query: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

export class SharedMappingInvalid
  extends Schema.TaggedError<SharedMappingInvalid, { readonly brand: unique symbol }>()(
    // Released serialized tag; changing stored/wire spellings is outside this cleanup.
    "Library.SkillMaterializationInvalid",
    { target: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class SetupImportInvalid
  extends Schema.TaggedError<SetupImportInvalid, { readonly brand: unique symbol }>()(
    "SetupImportInvalid",
    {
      skillName: Schema.String,
      reason: Schema.Literals([
        "duplicate-selection",
        "candidate-not-found",
        "observation-missing",
        "contested-observation",
        "source-unresolvable",
        "lock-changed",
      ]),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
