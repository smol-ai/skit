import { Schema } from "effect";
import { Hash } from "../shared/hash.js";
import { SkillAssessmentAcceptance } from "../library/assessment-acceptance.js";
import { SkillVersionId } from "../library/entity-ids.js";
export const SkillAuditFinding = Schema.Struct({
  fingerprint: Schema.optionalKey(Hash),
  analysisProfile: Schema.Struct({
    id: Schema.Literal("skit/finding/v1"),
    scope: Schema.Literals(["skill_artifact", "audited_file"]),
    acceptanceEligible: Schema.Boolean,
  }),
  artifactContentHash: Hash,
  ruleId: Schema.String,
  evidence: Schema.Literals([
    "declared",
    "deterministically_observed",
    "statically_possible",
    "model_suspected",
    "not_analyzed",
  ]),
  severity: Schema.Literals(["info", "low", "medium", "high", "critical"]),
  confidence: Schema.Literals(["low", "medium", "high"]),
  capability: Schema.optionalKey(Schema.String),
  location: Schema.Struct({
    path: Schema.optionalKey(Schema.String),
    line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    excerpt: Schema.String,
  }),
  message: Schema.String,
});
export type SkillAuditFinding = typeof SkillAuditFinding.Type;

export const SkillAudit = Schema.Struct({
  ruleset: Schema.Struct({ id: Schema.Literal("skit/skill-static-audit"), version: Schema.String }),
  declaredCapabilities: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  inferredCapabilities: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  undeclaredCapabilities: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  triggerBreadth: Schema.Literals(["explicit_only", "narrow", "broad", "unbounded", "unknown"]),
  authorityEffect: Schema.Literals(["none", "narrows", "expands", "unknown"]),
  confirmationEffect: Schema.Literals(["none", "requires", "suppresses", "unknown"]),
  riskFlags: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  truncatedEvidence: Schema.Struct({
    critical: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nonCriticalCapabilities: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  }),
  findings: Schema.mutableKey(Schema.mutable(Schema.Array(SkillAuditFinding))),
});
export type SkillAudit = typeof SkillAudit.Type;

export const SkillAssessmentContext = Schema.Literals(["author", "import", "project", "publish"]);
export type SkillAssessmentContext = typeof SkillAssessmentContext.Type;
const SkillAssessmentOutcome = Schema.Literals(["allow", "warn", "block"]);

const SkillAssessmentReason = Schema.Struct({
  code: Schema.String,
  ruleIds: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  capabilityIds: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
});

const SkillAcceptanceReviewRecord = Schema.Struct({
  ...SkillAssessmentAcceptance.fields,
  status: Schema.Literals(["applicable", "expired", "stale_digest"]),
});

const SkillFindingDecision = Schema.Struct({
  fingerprint: Hash,
  ruleId: Schema.String,
  disposition: Schema.Literals(["unresolved", "accepted"]),
  acceptance: Schema.optionalKey(SkillAssessmentAcceptance),
});

export const SkillAssessmentDecision = Schema.Struct({
  context: SkillAssessmentContext,
  outcome: SkillAssessmentOutcome,
  reasons: Schema.mutableKey(Schema.mutable(Schema.Array(SkillAssessmentReason))),
  findingDecisions: Schema.mutableKey(Schema.mutable(Schema.Array(SkillFindingDecision))),
});
export type SkillAssessmentDecision = typeof SkillAssessmentDecision.Type;

export const SkillSecurityReview = Schema.Struct({
  skill_version_id: SkillVersionId,
  artifactContentHash: Hash,
  audit: SkillAudit,
  assessment: SkillAssessmentDecision,
  acceptances: Schema.mutableKey(Schema.mutable(Schema.Array(SkillAcceptanceReviewRecord))),
});
export type SkillSecurityReview = typeof SkillSecurityReview.Type;
