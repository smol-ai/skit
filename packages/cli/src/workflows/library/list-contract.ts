import { SkillMetadata } from "../../library-application/skill-metadata.js";
import { Schema } from "effect";
import { CollectionId, Digest, SkillId, SkillVersionId } from "@smolai/skit-core";

export const ListResult = Schema.Struct({
  subjects: Schema.Array(
    Schema.Struct({
      subject_id: Schema.String,
      subject_kind: Schema.Literals(["collection", "skill"]),
      label: Schema.String,
      skills: Schema.Array(
        Schema.Struct({
          ...SkillMetadata.fields,
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
  /** What is enabled for every project: a whole Collection that follows its Source, or one Skill. */
  enabled: Schema.Array(
    Schema.Union([
      Schema.Struct({ collection: CollectionId, label: Schema.String }),
      Schema.Struct({ skill: SkillId, name: Schema.String }),
    ]),
  ),
  /** The Skills those items enable now. */
  enabled_skills: Schema.Array(Schema.String),
});
export type ListResult = typeof ListResult.Type;
