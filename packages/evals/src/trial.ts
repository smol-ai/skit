import { runCodexTurn } from "./codex.ts";
import { baseCaseFixture, messyHomeFixture, type Fixture } from "./fixtures.ts";
import { buildReport, writeReport, type TrialReport } from "./observe.ts";
import { createRunRoot } from "./run-root.ts";
import { installSkitPackage, linkTools } from "./skit-package.ts";

/** One agent task: the machine it starts on and what the user says. */
export interface EvalCase {
  readonly id: string;
  readonly prompt: string;
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
  fixture: messyHomeFixture,
};

export interface Trial {
  readonly report: TrialReport;
  readonly summaryPath: string;
}

export async function runTrial(
  evalCase: EvalCase,
  options: { allowSkit: boolean; timeoutMs: number; model?: string },
): Promise<Trial> {
  const skit = installSkitPackage();
  const run = createRunRoot(evalCase.id);
  linkTools(run, skit);
  const fixture = evalCase.fixture(run.home);
  const outcome = await runCodexTurn(run, {
    prompt: evalCase.prompt,
    allowSkit: options.allowSkit,
    timeoutMs: options.timeoutMs,
    ...(options.model ? { model: options.model } : {}),
  });
  const report = buildReport({
    run,
    prompt: evalCase.prompt,
    allowSkit: options.allowSkit,
    outcome,
    fixture,
    skitTarballSha256: skit.tarballSha256,
    skitGitHead: skit.gitHead,
  });
  return { report, summaryPath: writeReport(run, report) };
}
