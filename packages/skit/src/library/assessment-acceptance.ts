import { Schema } from "effect";
import { Hash } from "../shared/hash.js";
import { SkillVersionId } from "./entity-ids.js";
export const SkillAssessmentAcceptance = Schema.Struct({
  fingerprint: Hash,
  artifactContentHash: Hash,
  skill_version_id: SkillVersionId,
  context: Schema.Literal("project"),
  principal: Schema.String,
  rationale: Schema.String,
  acceptedAt: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
});
export type SkillAssessmentAcceptance = typeof SkillAssessmentAcceptance.Type;
