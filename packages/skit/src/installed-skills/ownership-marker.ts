import { Schema } from "effect";
import { Hash } from "../shared/hash.js";
import { InstalledSkillId, SkillId, SkillVersionId } from "../library/entity-ids.js";
export const OwnershipMarker = Schema.Struct({
  schemaVersion: Schema.Literal(5),
  installed_skill_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  expected_hash: Hash,
});
export type OwnershipMarker = typeof OwnershipMarker.Type;
