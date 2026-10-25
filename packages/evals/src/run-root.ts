import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Live run roots, removed once a run is archived. They are outside the skit checkout, and hold
 * nothing but the current run, so an agent that runs `pwd` or walks up from its home finds neither
 * the repository nor earlier runs' transcripts that would tell it the expected answer.
 */
export const runsDir = process.env.SKIT_EVAL_RUNS_DIR ?? join(realpathSync(tmpdir()), "skit-evals");

/**
 * One isolated trial. The agent sees `home` as `$HOME` and its working directory; Codex keeps its
 * config, sessions and credentials in `codexHome`, outside `home`, so the final snapshot of `home`
 * contains only what the agent and skit did.
 */
export interface RunRoot {
  readonly id: string;
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  /** The only directory on the agent's PATH besides the system directories. */
  readonly bin: string;
  readonly tmp: string;
  readonly evidence: string;
}

export function removeRunRoot(run: RunRoot): void {
  rmSync(run.root, { recursive: true, force: true });
}

export function createRunRoot(caseId: string): RunRoot {
  const id = `${caseId}-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
  const root = join(runsDir, id);
  const run: RunRoot = {
    id,
    root,
    home: join(root, "home"),
    codexHome: join(root, "codex-home"),
    bin: join(root, "bin"),
    tmp: join(root, "tmp"),
    evidence: join(root, "evidence"),
  };
  for (const dir of [run.home, run.codexHome, run.bin, run.tmp, run.evidence]) {
    mkdirSync(dir, { recursive: true });
  }
  return run;
}
