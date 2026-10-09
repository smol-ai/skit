import { Digest, SourceDiscoveryDiagnostic } from "@smolai/skit-core";
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
  collection_id: Schema.optionalKey(Schema.String),
  skill_ids: Schema.Array(Schema.String),
  retained_version_id: Schema.String,
  snapshot_digest: Digest,
  skills: Schema.Array(AddSkill),
  diagnostics: Schema.optionalKey(Schema.Array(SourceDiscoveryDiagnostic)),
});
export type AddResult = typeof AddResult.Type;
