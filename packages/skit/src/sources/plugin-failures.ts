import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { SchemaFailure } from "../shared/schema-issue.js";

export const PluginManifestInvalidReason = Schema.TaggedUnion({
  RelativePathInvalid: { requested: Schema.String },
  SourceEscape: { root: Schema.String, selected: Schema.String },
  LinkEscape: { root: Schema.String, target: Schema.String },
  DeclaredPathMissing: {},
  ManifestNotFile: { kind: Schema.String },
  ManifestTooLarge: { actual: Schema.Finite, limit: Schema.Int },
  InvalidJson: { failure: SchemaFailure },
  SkillPathsInvalid: { value: Schema.Json },
  SkillPathEscape: { root: Schema.String, requested: Schema.String },
  SkillDirectoryRequired: { kind: Schema.String },
  StrictInvalid: { value: Schema.Json },
  MarketplaceComponentsConflict: { fields: Schema.Array(Schema.String) },
  NameInvalid: { value: Schema.Json },
  PluginsArrayRequired: { value: Schema.optionalKey(Schema.Json) },
  MarketplaceTooLarge: { actual: Schema.Int, limit: Schema.Int },
  PluginEntryInvalid: { value: Schema.Json },
  PluginRootInvalid: { value: Schema.Json },
  LocalPathInvalid: { value: Schema.optionalKey(Schema.Json) },
  PluginSourceMissing: {},
});
export type PluginManifestInvalidReason = typeof PluginManifestInvalidReason.Type;

export class PluginManifestInvalid
  extends Schema.TaggedError<PluginManifestInvalid, { readonly brand: unique symbol }>()(
    "PluginManifestInvalid",
    { path: Schema.String, reason: PluginManifestInvalidReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}

export class PluginSkillConflict
  extends Schema.TaggedError<PluginSkillConflict, { readonly brand: unique symbol }>()(
    "PluginSkillConflict",
    {
      skillName: Schema.String,
      paths: Schema.Array(Schema.String),
      directories: Schema.Array(Schema.String),
      locators: Schema.optionalKey(Schema.Array(Schema.String)),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "VALIDATION_FAILED" as const;
}
export const PluginFailure = Schema.Union([PluginManifestInvalid, PluginSkillConflict]);
export type PluginFailure = typeof PluginFailure.Type;
