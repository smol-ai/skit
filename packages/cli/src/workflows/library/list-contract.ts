import { Schema } from "effect";
import { Digest, HarnessName, SkillId, SkillVersionId } from "@smolai/skit-core";

export const ListResult = Schema.Struct({
  collections: Schema.Array(
    Schema.Struct({
      collection_id: Schema.String,
      display_id: Schema.String,
      skills: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          skill_id: SkillId,
          selected_skill_version_id: Schema.optionalKey(SkillVersionId),
          versions: Schema.Array(
            Schema.Struct({
              skill_version_id: SkillVersionId,
              artifact_digest: Digest,
            }),
          ),
        }),
      ),
    }),
  ),
  bindings: Schema.Array(
    Schema.Struct({
      harness: HarnessName,
      skills: Schema.Array(Schema.String),
    }),
  ),
});
export type ListResult = typeof ListResult.Type;
