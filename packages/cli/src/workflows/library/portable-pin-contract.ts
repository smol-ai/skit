import { Schema } from "effect";
import { Digest, SkillId, SkillVersionId } from "@smolai/skit-core";

export const PortablePinPlan = Schema.Struct({
  subject_id: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      skill_id: SkillId,
      skill: Schema.String,
      current_version_id: Schema.optionalKey(SkillVersionId),
      selected_version_id: Schema.optionalKey(SkillVersionId),
    }),
  ),
  requested_version: Schema.optionalKey(Schema.String),
  snapshot_digest: Schema.optionalKey(Digest),
  retained: Schema.Boolean,
  changed: Schema.Boolean,
  bindings: Schema.Number,
});
export type PortablePinPlan = typeof PortablePinPlan.Type;

export const PortablePinResult = Schema.Struct({
  subject_id: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      skill_id: SkillId,
      skill: Schema.String,
      current_version_id: Schema.optionalKey(SkillVersionId),
      selected_version_id: SkillVersionId,
    }),
  ),
  requested_version: Schema.optionalKey(Schema.String),
  snapshot_digest: Schema.optionalKey(Digest),
  retained: Schema.Boolean,
  changed: Schema.Boolean,
  bindings: Schema.Number,
  projected: Schema.Number,
  deferred: Schema.Number,
});
export type PortablePinResult = typeof PortablePinResult.Type;
