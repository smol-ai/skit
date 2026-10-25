import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexSession } from "./codex.ts";
import { baseCaseFixture, messyHomeFixture, type Fixture } from "./fixtures.ts";
import { buildReport, writeReport, type TrialReport } from "./observe.ts";
import { archiveRun } from "./archive.ts";
import { createRunRoot, removeRunRoot } from "./run-root.ts";
import { installSkitPackage, linkTools } from "./skit-package.ts";

/** One agent task: the machine it starts on and what the user says. */
export interface EvalCase {
  readonly id: string;
  readonly prompt: string;
  /** What the user answers if the agent asks, in order. */
  readonly replies?: readonly string[];
  readonly fixture: (home: string) => Fixture;
}

/**
 * Case 0: observe what an agent does with the vague request swyx made, on the simplest machine.
 * The bare request leaves the agent unable to tell which "skit" is meant, so the prompt names the
 * command; everything after that is left to the agent.
 */
export const baseCase: EvalCase = {
  id: "setup-base",
  prompt: "set up skit for me. it's installed, run it with `skit`",
  fixture: baseCaseFixture,
};

/** Case 1: the same request on a machine with every kind of copy setup has to decide about. */
export const messyHomeCase: EvalCase = {
  id: "setup-messy",
  prompt: baseCase.prompt,
  // A user who keeps what agents see unchanged and wants their repositories included.
  replies: ["retain-only, and yes, include the repositories in ~/Work"],
  fixture: messyHomeFixture,
};

/**
 * Case 2: sign in for sync. Nobody approves the code, so the case observes how far the agent gets:
 * whether it can reach the Registry from the sandbox and hands the user the URL and code.
 */
export const loginCase: EvalCase = {
  id: "login",
  prompt:
    "log in to skit so I can sync my skills. it's installed, run it with `skit`. my registry is https://skit.timhanlon.com",
  fixture: baseCaseFixture,
};

/** The `skit` skill as this checkout ships it. */
const skitSkill = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/skit/SKILL.md");

export interface Trial {
  readonly report: TrialReport;
  readonly summaryPath: string;
}

export async function runTrial(
  evalCase: EvalCase,
  options: { allowSkit: boolean; withSkill: boolean; timeoutMs: number; model?: string },
): Promise<Trial> {
  const skit = installSkitPackage();
  const run = createRunRoot(evalCase.id);
  linkTools(run, skit);
  const fixture = evalCase.fixture(run.home);
  // As a user who enabled SKIT's own skill: Codex lists skills from `$HOME/.agents/skills`.
  if (options.withSkill) {
    const installed = join(run.home, ".agents", "skills", "skit", "SKILL.md");
    mkdirSync(dirname(installed), { recursive: true });
    copyFileSync(skitSkill, installed);
  }
  const outcome = await runCodexSession(run, {
    prompt: evalCase.prompt,
    replies: evalCase.replies ?? [],
    allowSkit: options.allowSkit,
    timeoutMs: options.timeoutMs,
    ...(options.model ? { model: options.model } : {}),
  });
  const report = buildReport({
    run,
    prompt: evalCase.prompt,
    allowSkit: options.allowSkit,
    withSkill: options.withSkill,
    outcome,
    fixture,
    skitTarballSha256: skit.tarballSha256,
    skitGitHead: skit.gitHead,
    skitGitDirty: skit.gitDirty,
  });
  writeReport(run, report);
  const archived = archiveRun(run, evalCase.id, report);
  removeRunRoot(run);
  return { report, summaryPath: join(archived, "evidence", "summary.md") };
}
