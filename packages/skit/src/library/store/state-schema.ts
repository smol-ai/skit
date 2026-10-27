import { Schema } from "effect";
import {
  CollectionId,
  LegacyMachineId,
  MachineId,
  InstalledSkillId,
  SkillId,
  SkillVersionId,
} from "../entity-ids.js";
import { Digest, HarnessName } from "../../vocabulary.js";

// Decoded state is readonly except where the transaction API revises a candidate in place.
// Each Schema.mutableKey below marks one such field; every other field stays readonly, so
// the schema records exactly which parts of a snapshot the reconciler is allowed to touch.
// Schema.optional retains existing candidate undefined values; JSON omits those keys.
export const InventoryScanIssue = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("MISSING_ROOT"),
  }),
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("UNREADABLE_PATH"),
  }),
  Schema.Struct({
    path: Schema.String,
    target: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("DANGLING_SYMLINK"),
  }),
]);
export type InventoryScanIssue = typeof InventoryScanIssue.Type;
export const SkillsShProvenanceObservation = Schema.Struct({
  type: Schema.Literal("skills.sh-lock"),
  machineId: Schema.Union([LegacyMachineId, MachineId]),
  observedAt: Schema.String,
  sourceUpdatedAt: Schema.optionalKey(Schema.String),
  lockPath: Schema.String,
  lockVersion: Schema.Number,
  lockScope: Schema.Literals(["project", "global"]),
  lockContentHash: Digest,
  source: Schema.String,
  sourceType: Schema.String,
  sourceUrl: Schema.optionalKey(Schema.String),
  sourceBaseUrl: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  skillName: Schema.String,
  skillPath: Schema.optionalKey(Schema.String),
  computedHash: Schema.optionalKey(Schema.String),
  skillFolderHash: Schema.optionalKey(Schema.String),
  wellKnownDigest: Schema.optionalKey(Schema.String),
  contentAgreement: Schema.Literals(["agrees", "mismatch", "unverifiable"]),
  originalEntry: Schema.JsonObject,
});
export type SkillsShProvenanceObservation = typeof SkillsShProvenanceObservation.Type;
export const SkillAssessmentAcceptance = Schema.Struct({
  fingerprint: Digest,
  artifactContentDigest: Digest,
  skill_version_id: SkillVersionId,
  context: Schema.Literal("project"),
  principal: Schema.String,
  rationale: Schema.String,
  acceptedAt: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
});
export type SkillAssessmentAcceptance = typeof SkillAssessmentAcceptance.Type;
export const HarnessInstallStatus = Schema.Literals([
  "pending",
  "installed",
  "drifted",
  "conflicted",
  "unsupported",
  "suppressed",
]);
export type HarnessInstallStatus = typeof HarnessInstallStatus.Type;
export const CustodyIssue = Schema.Struct({
  code: Schema.Literals(["ORPHANED_PROJECTION_CLAIM", "INVALID_OWNERSHIP_MARKER"]),
  path: Schema.String,
  canonicalPath: Schema.String,
  harnesses: Schema.mutable(Schema.Array(HarnessName)),
  observedHash: Digest,
  detail: Schema.optional(Schema.String),
  collectionId: Schema.optional(CollectionId),
  skillId: Schema.optional(SkillId),
  projectionId: Schema.optional(InstalledSkillId),
  expectedHash: Schema.optional(Digest),
  matchesExpectedHash: Schema.optional(Schema.Boolean),
});
export type CustodyIssue = typeof CustodyIssue.Type;
export const LibraryDeviceStateFields = {
  unmanaged: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          harness: HarnessName,
          /** All Harnesses that observed this one physical path during the latest pass. */
          harnesses: Schema.optional(Schema.mutable(Schema.Array(HarnessName))),
          path: Schema.String,
          paths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
          observedHash: Digest,
          lastObservedHash: Schema.optional(Digest),
        }),
      ),
    ),
  ),
  custodyIssues: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(CustodyIssue)))),
  scanIssues: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(InventoryScanIssue)))),
  assessmentAcceptances: Schema.mutableKey(
    Schema.optional(Schema.mutable(Schema.Array(SkillAssessmentAcceptance))),
  ),
} as const;
