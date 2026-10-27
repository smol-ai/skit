import { join } from "node:path";
import type { EvalCase } from "./cases.ts";
import { runCodexSession } from "./codex.ts";
import { buildReport, writeReport, type TrialReport } from "./observe.ts";
import { archiveRun } from "./archive.ts";
import { startLocalRegistry } from "./registry.ts";
import { createRunRoot, removeRunRoot } from "./run-root.ts";
import { installSkitPackage, linkTools } from "./skit-package.ts";

export interface Trial {
  readonly report: TrialReport;
  readonly summaryPath: string;
}

export async function runTrial(
  evalCase: EvalCase,
  options: { timeoutMs: number; model: string },
): Promise<Trial> {
  const skit = installSkitPackage();
  const run = createRunRoot(evalCase.id);
  linkTools(run, skit);
  const registry = await startLocalRegistry();
  try {
    const fixture = evalCase.fixture(run.home);
    const prompt = evalCase.prompt({ home: run.home, registry: registry.origin });
    const outcome = await runCodexSession(run, {
      prompt,
      permissions: evalCase.permissions,
      timeoutMs: options.timeoutMs,
      model: options.model,
    });
    const report = await buildReport({
      run,
      caseId: evalCase.id,
      prompt,
      permissions: evalCase.permissions,
      outcome,
      fixture,
      verify: (evidence) => evalCase.verify({ ...evidence, issued: registry.issued }),
      skitTarballSha256: skit.tarballSha256,
      skitGitHead: skit.gitHead,
      skitGitDirty: skit.gitDirty,
    });
    writeReport(run, report);
    const archived = archiveRun(run, report);
    removeRunRoot(run);
    return { report, summaryPath: join(archived, "evidence", "summary.md") };
  } finally {
    await registry.close();
  }
}
