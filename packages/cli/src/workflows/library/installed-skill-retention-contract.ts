import {
  Digest,
  InstalledSkillId,
  RecordedInstallDestination,
  SkillId,
  SkillVersionId,
} from "@smolai/skit-core";
import { Schema } from "effect";

const InstalledSkillRetentionObservation = Schema.Struct({
  projection_id: InstalledSkillId,
  target: RecordedInstallDestination,
  path: Schema.String,
  observed_digest: Digest,
  agreement: Schema.Literals(["selected", "identical", "different"]),
});

export const InstalledSkillRetentionPlan = Schema.Struct({
  revision: Schema.String,
  skill_id: SkillId,
  skill_name: Schema.String,
  previous_skill_version_id: SkillVersionId,
  selected_projection_id: InstalledSkillId,
  observed_digest: Digest,
  snapshot_digest: Digest,
  retained_path: Schema.String,
  retention_required: Schema.Boolean,
  projections: Schema.Array(InstalledSkillRetentionObservation),
});
export type InstalledSkillRetentionPlan = typeof InstalledSkillRetentionPlan.Type;

export const InstalledSkillRetentionResult = Schema.Struct({
  skill_id: SkillId,
  skill_name: Schema.String,
  previous_skill_version_id: SkillVersionId,
  retained_skill_version_id: SkillVersionId,
  retained_copy_id: Schema.String,
  snapshot_digest: Digest,
  retained: Schema.Boolean,
  projections: Schema.Array(
    Schema.Struct({
      projection_id: InstalledSkillId,
      target: RecordedInstallDestination,
      path: Schema.String,
      status: Schema.Literals(["projected", "conflicted", "deferred"]),
    }),
  ),
});
export type InstalledSkillRetentionResult = typeof InstalledSkillRetentionResult.Type;
