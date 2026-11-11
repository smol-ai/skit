import { Schema } from "effect";
import { Hash } from "../shared/hash.js";
import { InstalledSkillId, SkillId } from "../library/entity-ids.js";
import type { OwnershipMarkerInspection } from "./marker-inspection.js";
import { OwnershipMarkerInvalidReason } from "./marker-failures.js";

/** Failed ownership and content checks, in observation order. None implies permission to overwrite. */
export const InstalledSkillConflict = Schema.TaggedUnion({
  MarkerMissing: {},
  MarkerInvalid: { reason: OwnershipMarkerInvalidReason },
  SkillMismatch: { expected: SkillId, actual: SkillId },
  InstalledSkillMismatch: {
    expected: Schema.optionalKey(InstalledSkillId),
    actual: InstalledSkillId,
  },
  MarkerHashMismatch: { expected: Hash, actual: Hash },
  ContentChanged: {
    expected: Hash,
    actual: Hash,
    baseline: Schema.Literals(["marker", "library"]),
  },
});
export type InstalledSkillConflict = typeof InstalledSkillConflict.Type;

/** Compare all available evidence, using the Library baseline when no valid marker exists. */
export function installedSkillConflicts(
  expected: {
    readonly skill_id: SkillId;
    readonly installed_skill_id?: InstalledSkillId;
    readonly expected_hash?: Hash;
  },
  inspection: OwnershipMarkerInspection,
  currentHash: Hash,
): InstalledSkillConflict[] {
  if (inspection.kind !== "valid") {
    const conflicts: InstalledSkillConflict[] = [
      inspection.kind === "absent"
        ? { _tag: "MarkerMissing" }
        : { _tag: "MarkerInvalid", reason: inspection.reason },
    ];
    if (expected.expected_hash !== undefined && currentHash !== expected.expected_hash)
      conflicts.push({
        _tag: "ContentChanged",
        expected: expected.expected_hash,
        actual: currentHash,
        baseline: "library",
      });
    return conflicts;
  }
  const marker = inspection.marker;
  const conflicts: InstalledSkillConflict[] = [];
  if (marker.skill_id !== expected.skill_id)
    conflicts.push({ _tag: "SkillMismatch", expected: expected.skill_id, actual: marker.skill_id });
  if (marker.installed_skill_id !== expected.installed_skill_id)
    conflicts.push({
      _tag: "InstalledSkillMismatch",
      ...(expected.installed_skill_id === undefined
        ? {}
        : { expected: expected.installed_skill_id }),
      actual: marker.installed_skill_id,
    });
  if (expected.expected_hash !== undefined && marker.expected_hash !== expected.expected_hash)
    conflicts.push({
      _tag: "MarkerHashMismatch",
      expected: expected.expected_hash,
      actual: marker.expected_hash,
    });
  if (currentHash !== marker.expected_hash)
    conflicts.push({
      _tag: "ContentChanged",
      expected: marker.expected_hash,
      actual: currentHash,
      baseline: "marker",
    });
  return conflicts;
}
