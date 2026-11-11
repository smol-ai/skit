import { Schema } from "effect";
import { Hash } from "@smolai/skit-core/shared";

import { SkillsShUpdateMember } from "@smolai/skit-core/library";

export const CheckResult = Schema.Array(
  Schema.Struct({
    subject_id: Schema.String,
    subject_kind: Schema.Literals(["collection", "skill"]),
    label: Schema.String,
    collection_versions: Schema.Array(
      Schema.Struct({
        collection_version_id: Schema.String,
        hash: Hash,
        original_intact: Schema.Boolean,
      }),
    ),
    unresolved_skill_selections: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    source_status: Schema.Literals(["current", "changed", "unverified", "not-applicable"]),
    current_snapshot_digest: Schema.optionalKey(Hash),
    available_snapshot_digest: Schema.optionalKey(Hash),
    has_imports: Schema.Boolean,
    skills_sh: Schema.optionalKey(
      Schema.Struct({
        checked_at: Schema.String,
        members: Schema.Array(SkillsShUpdateMember),
      }),
    ),
  }),
);
export type CheckResult = typeof CheckResult.Type;

export const checkOutputContracts = {
  check: { id: "skit.check.v8", schema: CheckResult },
} as const;
