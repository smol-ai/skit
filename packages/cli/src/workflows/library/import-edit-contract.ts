import {
  Hash,
  InstalledSkillId,
  RecordedInstallDestination,
  SkillId,
  SkillVersionId,
} from "@smolai/skit-core";
import { Schema } from "effect";

const EditCandidate = Schema.Struct({
  installed_skill_id: InstalledSkillId,
  destination: RecordedInstallDestination,
  path: Schema.String,
  current_hash: Hash,
  agreement: Schema.Literals(["selected", "identical", "different"]),
});

export const EditImportPlan = Schema.Struct({
  revision: Schema.String,
  skill_id: SkillId,
  skill_name: Schema.String,
  previous_skill_version_id: SkillVersionId,
  selected_installed_skill_id: InstalledSkillId,
  current_hash: Hash,
  snapshot_digest: Hash,
  original_path: Schema.String,
  import_required: Schema.Boolean,
  installed_skills: Schema.Array(EditCandidate),
});
export type EditImportPlan = typeof EditImportPlan.Type;

export const EditImportResult = Schema.Struct({
  skill_id: SkillId,
  skill_name: Schema.String,
  previous_skill_version_id: SkillVersionId,
  imported_skill_version_id: SkillVersionId,
  collection_version_id: Schema.String,
  snapshot_digest: Hash,
  imported: Schema.Boolean,
  installed_skills: Schema.Array(
    Schema.Struct({
      installed_skill_id: InstalledSkillId,
      destination: RecordedInstallDestination,
      path: Schema.String,
      status: Schema.Literals(["installed", "conflicted", "deferred"]),
    }),
  ),
});
export type EditImportResult = typeof EditImportResult.Type;
