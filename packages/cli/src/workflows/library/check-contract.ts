import { Schema } from "effect";
import { Digest } from "@smolai/skit-core";

const SkillsShMemberCheck = Schema.Struct({
  skill_name: Schema.String,
  skill_path: Schema.optionalKey(Schema.String),
  hash_kind: Schema.optionalKey(Schema.Literals(["computedHash", "skillFolderHash"])),
  status: Schema.Literals([
    "current",
    "update-available",
    "removed-upstream",
    "lock-stale",
    "differs-from-lock-and-upstream",
    "unverifiable",
    "not-applicable",
  ]),
  baseline_commit: Schema.optionalKey(Schema.String),
  baseline_tree: Schema.optionalKey(Schema.String),
  baseline_verification: Schema.optionalKey(Schema.Literals(["lock-only", "lock+retained-bytes"])),
  upstream_commit: Schema.optionalKey(Schema.String),
  upstream_tree: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});

export const CheckResult = Schema.Array(
  Schema.Struct({
    subject_id: Schema.String,
    subject_kind: Schema.Literals(["collection", "skill"]),
    label: Schema.String,
    retained_copies: Schema.Array(
      Schema.Struct({
        retained_copy_id: Schema.String,
        digest: Digest,
        retained_bytes_current: Schema.Boolean,
      }),
    ),
    unresolved_skill_selections: Schema.Number,
    source_status: Schema.Literals(["current", "changed", "unverified", "not-applicable"]),
    current_snapshot_digest: Schema.optionalKey(Digest),
    available_snapshot_digest: Schema.optionalKey(Digest),
    acquisition_provenance: Schema.Boolean,
    skills_sh: Schema.optionalKey(
      Schema.Struct({
        checked_at: Schema.String,
        members: Schema.Array(SkillsShMemberCheck),
      }),
    ),
  }),
);
export type CheckResult = typeof CheckResult.Type;
