import { Schema } from "effect";
import { HarnessName } from "../harnesses/contracts.js";
import { Hash } from "../shared/hash.js";
import { CollectionId, SkillId, InstalledSkillId } from "../library/entity-ids.js";
import { OwnershipMarkerInvalidReason } from "./marker-failures.js";
export const HarnessInstallStatus = Schema.Literals([
  "pending",
  "installed",
  "drifted",
  "conflicted",
  "unsupported",
  "suppressed",
]);
export type HarnessInstallStatus = typeof HarnessInstallStatus.Type;

export const OwnershipIssue = Schema.Struct({
  code: Schema.Literals(["ORPHANED_OWNERSHIP_MARKER", "INVALID_OWNERSHIP_MARKER"]),
  path: Schema.String,
  canonicalPath: Schema.String,
  harnesses: Schema.mutable(Schema.Array(HarnessName)),
  currentHash: Hash,
  markerReason: Schema.optionalKey(OwnershipMarkerInvalidReason),
  collectionId: Schema.optional(CollectionId),
  skillId: Schema.optional(SkillId),
  installedSkillId: Schema.optional(InstalledSkillId),
  expectedHash: Schema.optional(Hash),
  matchesExpectedHash: Schema.optional(Schema.Boolean),
});
export type OwnershipIssue = typeof OwnershipIssue.Type;
