import { Schema } from "effect";
import { SkillId } from "../entity-ids.js";
import { HarnessName } from "../store/state-schema.js";
import type { LibraryState } from "../library-state.js";

/** One diagnostic report over an observed inventory snapshot. Pure: the caller does the reading. */
export const LibraryDoctorIssue = Schema.Struct({
  code: Schema.String,
  skillId: Schema.optional(SkillId),
  path: Schema.optional(Schema.String),
  harness: Schema.optional(HarnessName),
  harnesses: Schema.optional(Schema.Array(HarnessName)),
});
export type LibraryDoctorIssue = typeof LibraryDoctorIssue.Type;

export const LibraryDoctorReport = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(LibraryDoctorIssue),
});
export type LibraryDoctorReport = typeof LibraryDoctorReport.Type;

export function libraryDoctorReport(state: LibraryState): LibraryDoctorReport {
  const issues: LibraryDoctorIssue[] = state.projections
    .filter((item) => item.status !== "installed" && item.status !== "unsupported")
    .map((item) => ({
      code: item.status === "conflicted" ? "PROJECTION_CONFLICT" : "PROJECTION_DRIFT",
      skillId: item.skill_id,
      path: item.path,
      harness: item.harness,
    }));
  issues.push(
    ...(state.scanIssues ?? [])
      .filter((item) => item.code === "UNREADABLE_PATH")
      .map((item) => ({ ...item })),
    ...(state.custodyIssues ?? []).map((item) => ({
      code: item.code,
      skillId: item.skillId,
      path: item.path,
      harnesses: item.harnesses,
    })),
  );
  return { ok: issues.length === 0, issues };
}
