import { InstalledSkillConflict } from "../../installed-skills/conflict.js";
import { OwnershipMarkerInvalidReason } from "../../installed-skills/marker-failures.js";
import { Schema } from "effect";
import { SkillId } from "../entity-ids.js";
import { HarnessName } from "../../harnesses/contracts.js";
import { InstallDestination } from "../../installed-skills/destination.js";
import type { LibraryInventory } from "../library-state.js";

/** One diagnostic report over an observed inventory snapshot. Pure: the caller does the reading. */
const LibraryDoctorIssue = Schema.Struct({
  code: Schema.String,
  conflicts: Schema.optionalKey(Schema.Array(InstalledSkillConflict)),
  markerReason: Schema.optionalKey(OwnershipMarkerInvalidReason),
  skillId: Schema.optional(SkillId),
  path: Schema.optional(Schema.String),
  target: Schema.optional(InstallDestination),
  harnesses: Schema.optional(Schema.Array(HarnessName)),
});
type LibraryDoctorIssue = typeof LibraryDoctorIssue.Type;

export const LibraryDoctorReport = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(LibraryDoctorIssue),
});
export type LibraryDoctorReport = typeof LibraryDoctorReport.Type;

export function libraryDoctorReport(state: LibraryInventory): LibraryDoctorReport {
  const issues: LibraryDoctorIssue[] = state.installed_skills
    .filter((item) => item.status !== "installed")
    .map((item) => ({
      code: item.status === "conflicted" ? "PROJECTION_CONFLICT" : "PROJECTION_DRIFT",
      ...(item.status === "conflicted" ? { conflicts: item.conflicts } : {}),
      skillId: item.skill_id,
      path: item.path,
      target: item.destination,
    }));
  issues.push(
    ...(state.scanIssues ?? [])
      .filter((item) => item.code === "UNREADABLE_PATH")
      .map((item) => ({ ...item })),
    ...(state.ownershipIssues ?? []).map((item) => ({
      code: item.code,
      skillId: item.skillId,
      path: item.path,
      harnesses: item.harnesses,
      ...(item.markerReason === undefined ? {} : { markerReason: item.markerReason }),
    })),
  );
  return { ok: issues.length === 0, issues };
}
