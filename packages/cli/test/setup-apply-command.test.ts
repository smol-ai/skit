import { assert, it } from "vitest";
import { setupApplyCommandLine } from "../src/workflows/library/setup-decisions.js";

const planId = `sha256:${"a".repeat(64)}`;

// Agent harnesses match allow rules only against literal words, so the command never relies on
// shell expansion and quotes anything a shell would split or expand.
it("prints a literal command an allow rule can match", () => {
  assert.strictEqual(
    setupApplyCommandLine({
      planId,
      repositoryRoots: ["/Users/me/Work"],
      needsDuplicateDecision: false,
    }),
    `skit setup --apply ${planId} --work-dir /Users/me/Work`,
  );
  assert.strictEqual(
    setupApplyCommandLine({
      planId,
      repositoryRoots: ["/Users/me/My Work"],
      needsDuplicateDecision: true,
    }),
    `skit setup --apply ${planId} --work-dir '/Users/me/My Work' --duplicates <retain-only|keep-both|retire-aliases>`,
  );
});
