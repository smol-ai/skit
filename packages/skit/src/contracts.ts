import { Schema } from "effect";
import {
  SKILL_EXAMPLE_SCHEMA_VERSION,
  SKIT_DESCRIPTOR_VERSION,
  type ContainedSkillDescriptor,
  type SharedMapping,
  type SkillExampleManifest,
  type SkitDescriptor,
} from "./schemas.js";
import {
  Digest,
  HarnessName,
  InvocationPolicy,
  SkillsShProvenanceObservation,
  SkitBindingScope,
  SkillAssessmentAcceptance,
  SkitValidationDiagnostic,
} from "./library/store/state-schema.js";
import { CollectionId, ProjectionId, SkillId, SkillVersionId } from "./library/entity-ids.js";
export {
  Digest,
  HarnessName,
  InvocationPolicy,
  SkillsShProvenanceObservation,
  SkitBindingScope,
  SkillAssessmentAcceptance,
  SkitValidationDiagnostic,
};
export type {
  HarnessInstallStatus,
  CustodyIssue,
  SkitSource,
} from "./library/store/state-schema.js";
export {
  SKILL_EXAMPLE_SCHEMA_VERSION,
  SKIT_DESCRIPTOR_VERSION,
  type ContainedSkillDescriptor,
  type SharedMapping,
  type SkillExampleManifest,
  type SkitDescriptor,
};

export const LibraryInvocationOption = Schema.Union([InvocationPolicy, Schema.Literal("declared")]);
export type LibraryInvocationOption = typeof LibraryInvocationOption.Type;

export type RegistrySkitDescriptor = SkitDescriptor & { readonly id: string };

export interface SkitFileRecord {
  path: string;
  digest: Digest;
  bytes: number;
  mediaType: string;
  executable: boolean;
}

export interface SyncFileVersion {
  digest: Digest;
  bytes: Uint8Array;
  mediaType: string;
}

export interface SyncConflict {
  path: string;
  kind: "both_modified" | "delete_modify" | "binary" | "descriptor";
}

export interface SyncPlan {
  files: Record<string, SyncFileVersion>;
  conflicts: SyncConflict[];
  changedPaths: string[];
}

export interface SkillExampleRecord {
  path: string;
  manifest: SkillExampleManifest;
}

export interface ValidatedSkit {
  descriptor: SkitDescriptor;
  files: SkitFileRecord[];
  identity: SkitReleaseIdentity;
  diagnostics: SkitValidationDiagnostic[];
  audits: Record<string, SkillAudit>;
  assessments: Record<string, SkillAssessmentDecision>;
  examples: SkillExampleRecord[];
}

export interface SkitReleaseIdentity {
  slug: string;
  release: string;
  releaseContentHash: Digest;
  skills: Array<{
    name: string;
    contentHash: Digest;
    enabled: boolean;
  }>;
}

export const OwnershipMarkerV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  projectionPolicyVersion: Schema.Literal(1),
  projection_id: ProjectionId,
  collection_id: CollectionId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  expected_digest: Digest,
  harness: HarnessName,
});
export type OwnershipMarkerV2 = typeof OwnershipMarkerV2.Type;

export const OwnershipMarkerV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  projectionPolicyVersion: Schema.Literal(1),
  projection_id: ProjectionId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  expected_digest: Digest,
  harness: HarnessName,
});
export type OwnershipMarkerV3 = typeof OwnershipMarkerV3.Type;

/** V2 remains readable because ownership markers live outside versioned Library state. */
export const OwnershipMarker = OwnershipMarkerV3;
export type OwnershipMarker = typeof OwnershipMarker.Type;

export const SkillAuditFinding = Schema.Struct({
  fingerprint: Schema.optionalKey(Digest),
  analysisProfile: Schema.Struct({
    id: Schema.Literal("skit/finding/v1"),
    scope: Schema.Literals(["skill_artifact", "audited_file"]),
    acceptanceEligible: Schema.Boolean,
  }),
  artifactContentDigest: Digest,
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

export const SkillAssessmentContext = Schema.Literals(["author", "retain", "project", "publish"]);
export type SkillAssessmentContext = typeof SkillAssessmentContext.Type;
export const SkillAssessmentOutcome = Schema.Literals(["allow", "warn", "block"]);
export type SkillAssessmentOutcome = typeof SkillAssessmentOutcome.Type;

export const SkillAssessmentReason = Schema.Struct({
  code: Schema.String,
  ruleIds: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
  capabilityIds: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))),
});
export type SkillAssessmentReason = typeof SkillAssessmentReason.Type;

export const SkillAcceptanceReviewRecord = Schema.Struct({
  ...SkillAssessmentAcceptance.fields,
  status: Schema.Literals(["applicable", "expired", "stale_digest"]),
});
export type SkillAcceptanceReviewRecord = typeof SkillAcceptanceReviewRecord.Type;

export const SkillFindingDecision = Schema.Struct({
  fingerprint: Digest,
  ruleId: Schema.String,
  disposition: Schema.Literals(["unresolved", "accepted"]),
  acceptance: Schema.optionalKey(SkillAssessmentAcceptance),
});
export type SkillFindingDecision = typeof SkillFindingDecision.Type;

export const SkillAssessmentDecision = Schema.Struct({
  context: SkillAssessmentContext,
  outcome: SkillAssessmentOutcome,
  reasons: Schema.mutableKey(Schema.mutable(Schema.Array(SkillAssessmentReason))),
  findingDecisions: Schema.mutableKey(Schema.mutable(Schema.Array(SkillFindingDecision))),
});
export type SkillAssessmentDecision = typeof SkillAssessmentDecision.Type;

export const SkillSecurityReview = Schema.Struct({
  skill_version_id: SkillVersionId,
  artifactContentDigest: Digest,
  audit: SkillAudit,
  assessment: SkillAssessmentDecision,
  acceptances: Schema.mutableKey(Schema.mutable(Schema.Array(SkillAcceptanceReviewRecord))),
});
export type SkillSecurityReview = typeof SkillSecurityReview.Type;
