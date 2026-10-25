import { describe, expect, it } from "vitest";
import { baseCase, messyHomeCase, runTrial } from "../src/trial.ts";

const repeat = Number(process.env.SKIT_EVAL_REPEAT ?? "1");
const model = process.env.SKIT_EVAL_MODEL;
const only = process.env.SKIT_EVAL_CASE;
const cases = [baseCase, messyHomeCase].filter((evalCase) => !only || evalCase.id === only);

// Observation first: the only assertions are the hard failures. Everything else is in each run's
// evidence/summary.md, which is the point of a case.
describe.each(cases)("$id", (evalCase) => {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    it(`attempt ${attempt}`, async () => {
      const { report, summaryPath } = await runTrial(evalCase, {
        timeoutMs: 600_000,
        ...(model ? { model } : {}),
      });
      console.info(`summary: ${summaryPath}`);
      expect(report.hardFailures).toEqual([]);
    });
  }
});
