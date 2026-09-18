import { Digest, HarnessName, ProjectionId, SkillId, SkillVersionId } from "@smolai/skit-core";
import { Schema } from "effect";

const ProjectionRetentionObservation = Schema.Struct({
  projection_id: ProjectionId,
  harness: HarnessName,
  path: Schema.String,
  observed_digest: Digest,
  agreement: Schema.Literals(["selected", "identical", "different"]),
});

export const ProjectionRetentionPlan = Schema.Struct({
  revision: Schema.String,
  skill_id: SkillId,
  skill_name: Schema.String,
  previous_skill_version_id: SkillVersionId,
  selected_projection_id: ProjectionId,
  observed_digest: Digest,
  snapshot_digest: Digest,
  retained_path: Schema.String,
  retention_required: Schema.Boolean,
  projections: Schema.Array(ProjectionRetentionObservation),
});
export type ProjectionRetentionPlan = typeof ProjectionRetentionPlan.Type;

export const ProjectionRetentionResult = Schema.Struct({
  skill_id: SkillId,
  skill_name: Schema.String,
  previous_skill_version_id: SkillVersionId,
  retained_skill_version_id: SkillVersionId,
  retained_copy_id: Schema.String,
  snapshot_digest: Digest,
  retained: Schema.Boolean,
  projections: Schema.Array(
    Schema.Struct({
      projection_id: ProjectionId,
      harness: HarnessName,
      path: Schema.String,
      status: Schema.Literals(["projected", "conflicted", "deferred"]),
    }),
  ),
});
export type ProjectionRetentionResult = typeof ProjectionRetentionResult.Type;
