import { Schema } from "effect";
import { CollectionId, Digest, HarnessName, SkillId, SkillVersionId } from "@smolai/skit-core";

export const ListResult = Schema.Struct({
  subjects: Schema.Array(
    Schema.Struct({
      subject_id: Schema.String,
      subject_kind: Schema.Literals(["collection", "skill"]),
      label: Schema.String,
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
      /** What was enabled: a whole Collection that follows its Source, or one Skill. */
      entries: Schema.Array(
        Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("collection"),
            collection_id: CollectionId,
            label: Schema.String,
          }),
          Schema.Struct({ kind: Schema.Literal("skill"), skill_id: SkillId, name: Schema.String }),
        ]),
      ),
      /** The Skills those entries enable now. */
      skills: Schema.Array(Schema.String),
    }),
  ),
});
export type ListResult = typeof ListResult.Type;
