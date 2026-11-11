import { Hash } from "@smolai/skit-core/shared";
import { SourceDiscoveryDiagnostic } from "@smolai/skit-core/library/source";
import { Schema } from "effect";

const AddSkill = Schema.Struct({
  name: Schema.String,
  verbatim_path: Schema.String,
});

export const AddPreview = Schema.Struct({
  kind: Schema.Literals(["plain", "authored"]),
  skills: Schema.Array(AddSkill),
  diagnostics: Schema.optionalKey(Schema.Array(SourceDiscoveryDiagnostic)),
});
export type AddPreview = typeof AddPreview.Type;

export const AddResult = Schema.Struct({
  action: Schema.Literals(["added", "updated", "unchanged"]),
  collection_id: Schema.optionalKey(Schema.String),
  skill_ids: Schema.Array(Schema.String),
  collection_version_id: Schema.String,
  snapshot_digest: Hash,
  skills: Schema.Array(AddSkill),
  diagnostics: Schema.optionalKey(Schema.Array(SourceDiscoveryDiagnostic)),
});
export type AddResult = typeof AddResult.Type;

export const addOutputContracts = {
  add: { id: "skit.add.v7", schema: AddResult },
  addPreview: { id: "skit.add.preview.v5", schema: AddPreview },
} as const;
