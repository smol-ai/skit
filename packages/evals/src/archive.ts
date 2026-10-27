import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Permissions } from "./codex.ts";
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
  readonly permissions: Permissions;
  readonly codexVersion: string;
  readonly model: string;
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
  const archivedHome = join(destination, "home");
  cpSync(run.home, archivedHome, { recursive: true, verbatimSymlinks: true });
  // Keep internal absolute links usable after the live run is removed. Relative and external
  // links retain their targets; the report records every original fixture link verbatim.
  const relocateLinks = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) relocateLinks(path);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        const withinHome = relative(run.home, target);
        if (
          isAbsolute(target) &&
          withinHome !== ".." &&
          !withinHome.startsWith(`..${sep}`) &&
          !isAbsolute(withinHome)
        ) {
          unlinkSync(path);
          symlinkSync(relative(dirname(path), join(archivedHome, withinHome)) || ".", path);
        }
      }
    }
  };
  relocateLinks(archivedHome);
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
    permissions: report.permissions,
    codexVersion: report.codex.codexVersion,
    model: report.codex.model,
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
