import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { SchemaFailure } from "../../../shared/schema-issue.js";

/** Every conflict has a key to name it by and the choice that ends it. */
const fields = {
  key: Schema.String,
  resolution: Schema.Literals(["take-remote", "keep-enabled", "local"]),
};

/**
 * Sync conflict facts shared by the Library planner and transport-facing results. Each says what
 * happened and to what; front ends write the words.
 */
export const SyncConflictDetail = Schema.TaggedUnion({
  /** Both devices changed a Collection, or one removed it while the other changed its content. */
  CollectionChanged: { ...fields, label: Schema.String },
  /** A Skill differs between devices. */
  SkillChanged: { ...fields, name: Schema.String },
  /** Both devices changed the record `key` names. */
  RecordChanged: fields,
  /** The merged Library breaks a rule of the Library format. */
  LibraryInvalid: { ...fields, failure: SchemaFailure },
  /** Several Skills install to one destination. */
  DestinationCollision: {
    ...fields,
    skills: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, collection: Schema.String }),
    ),
  },
  /** An enabled Skill has no current Version. */
  MissingSkillVersion: { ...fields, name: Schema.String },
  /** No Version of its Skill can replace an installed copy. */
  MissingInstalledSkillVersion: { ...fields, path: Schema.String },
  /** An installed copy's files or ownership changed, and sync would replace or remove it. */
  InstalledSkillChanged: { ...fields, path: Schema.String },
  /** A repository still enables a Skill or Collection the Library no longer has. */
  RepositoryEnabledInvalid: { ...fields, root: Schema.String },
});
export type SyncConflictDetail = typeof SyncConflictDetail.Type;

/** Sync cannot apply while conflicts remain. Front ends write the words for each. */
export class SyncConflicted
  extends Schema.TaggedError<SyncConflicted, { readonly brand: unique symbol }>()(
    "Library.SyncConflicted",
    { conflicts: Schema.Array(SyncConflictDetail) },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class SyncLocalChanged
  extends Schema.TaggedError<SyncLocalChanged, { readonly brand: unique symbol }>()(
    "Library.SyncLocalChanged",
    {},
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
