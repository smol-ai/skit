import { describe, expect, it } from "vitest";
import { baseCase, runTrial } from "../src/trial.ts";

const repeat = Number(process.env.SKIT_EVAL_REPEAT ?? "1");
const model = process.env.SKIT_EVAL_MODEL;
const sandbox =
  process.env.SKIT_EVAL_SANDBOX === "danger-full-access" ? "danger-full-access" : "workspace-write";

// Observation first: the only assertions are the hard failures. Everything else is in each run's
// evidence/summary.md, which is the point of the case.
describe("set up skit for me · base case", () => {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    it(`attempt ${attempt}`, async () => {
      const { report, summaryPath } = await runTrial(baseCase, {
        sandbox,
        timeoutMs: 600_000,
        ...(model ? { model } : {}),
      });
      console.info(`summary: ${summaryPath}`);
      expect(report.hardFailures).toEqual([]);
    });
  }
});
