import { Schema } from "effect";
import { PlatformErrorSchema } from "../platform/error-schema.js";
import { GitInspectionFailed } from "./update-failures.js";

export const SkillsShUpdateReason = Schema.TaggedUnion({
  WellKnownSource: {},
  GitSourceMissing: {},
  MirrorUnavailable: { failure: Schema.Union([GitInspectionFailed, PlatformErrorSchema]) },
  RefUnavailable: { ref: Schema.String, failure: GitInspectionFailed },
  GitEvidenceUnavailable: { failure: GitInspectionFailed },
  LockIncomplete: { missing: Schema.Array(Schema.Literals(["skill-path", "hash"])) },
  BaselineNotFound: {
    hashKind: Schema.Literals(["computedHash", "skillFolderHash"]),
    ref: Schema.String,
  },
  TreeHashCannotVerifyOriginalBytes: {},
  OriginalBytesUnavailable: { failures: Schema.Array(PlatformErrorSchema) },
});
export type SkillsShUpdateReason = typeof SkillsShUpdateReason.Type;

export const SkillsShUpdateMember = Schema.Struct({
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
  baseline_verification: Schema.optionalKey(Schema.Literals(["lock-only", "lock+original-bytes"])),
  upstream_commit: Schema.optionalKey(Schema.String),
  upstream_tree: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(SkillsShUpdateReason),
});
export type SkillsShUpdateMember = typeof SkillsShUpdateMember.Type;
