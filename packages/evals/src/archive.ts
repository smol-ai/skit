import { appendFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { TrialReport } from "./observe.ts";
import type { RunRoot } from "./run-root.ts";

/**
 * Where finished runs are kept. It is durable, unlike the live run roots in the system temporary
 * directory, which macOS clears, and it sits under the developer's real home rather than any
 * agent's.
 */
export const archiveDir =
  process.env.SKIT_EVAL_ARCHIVE_DIR ?? join(userInfo().homedir, ".skit-evals");

/** One line of `runs.jsonl`: enough to find, filter and compare runs without opening them. */
export interface RunIndexEntry {
  readonly runId: string;
  readonly case: string;
  readonly archivedAt: string;
  readonly rules: readonly (readonly string[])[];
  readonly withSkill: boolean;
  readonly codexVersion: string;
  readonly skitGitHead: string;
  readonly skitGitDirty: boolean;
  readonly skitTarballSha256: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly failures: readonly string[];
  readonly librarySkills: number;
  readonly projections: Readonly<Record<string, number>>;
  readonly path: string;
}

/**
 * Keep what a run proves and drop what a fresh Codex home downloads: the evidence, the machine as
 * the agent left it (links kept as links), and Codex's own session transcripts. Then index the run
 * and remove its live root.
 */
export function archiveRun(run: RunRoot, report: TrialReport): string {
  const destination = join(archiveDir, "runs", run.id);
  mkdirSync(destination, { recursive: true });
  cpSync(run.evidence, join(destination, "evidence"), { recursive: true });
  cpSync(run.home, join(destination, "home"), { recursive: true, verbatimSymlinks: true });
  const sessions = join(run.codexHome, "sessions");
  if (existsSync(sessions))
    cpSync(sessions, join(destination, "codex-sessions"), { recursive: true });

  const projections: Record<string, number> = {};
  for (const projection of report.observation.library.projections)
    projections[projection.status] = (projections[projection.status] ?? 0) + 1;
  const entry: RunIndexEntry = {
    runId: run.id,
    case: report.case,
    archivedAt: new Date().toISOString(),
    rules: report.rules,
    withSkill: report.withSkill,
    codexVersion: report.codex.codexVersion,
    skitGitHead: report.skitGitHead,
    skitGitDirty: report.skitGitDirty,
    skitTarballSha256: report.skitTarballSha256,
    durationMs: report.codex.durationMs,
    exitCode: report.codex.exitCode,
    failures: report.failures,
    librarySkills: report.observation.library.skills.length,
    projections,
    path: destination,
  };
  appendFileSync(join(archiveDir, "runs.jsonl"), `${JSON.stringify(entry)}\n`);
  return destination;
}
