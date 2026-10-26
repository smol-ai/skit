import { beforeAll, describe, expect, it } from "vitest";
import { cases } from "../src/cases.ts";
import { checkCodexReady } from "../src/codex.ts";
import { runTrial } from "../src/trial.ts";

const repeat = Number(process.env.SKIT_EVAL_REPEAT ?? "1");
const model = process.env.SKIT_EVAL_MODEL;
const only = process.env.SKIT_EVAL_CASE;

beforeAll(checkCodexReady);

// Each trial passes only when its case's checks find the task done, from the machine's final
// state; each run's evidence/summary.md shows why it failed.
describe.each(cases.filter((evalCase) => !only || evalCase.id === only))("$id", (evalCase) => {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    it(`attempt ${attempt}`, async () => {
      const { report, summaryPath } = await runTrial(evalCase, {
        timeoutMs: 600_000,
        ...(model ? { model } : {}),
      });
      console.info(
        `${report.failures.length === 0 ? "PASS" : "FAIL"} ${evalCase.id} · ${summaryPath}`,
      );
      expect(report.failures).toEqual([]);
    });
  }
});
