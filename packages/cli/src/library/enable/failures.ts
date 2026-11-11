import { describeFailure } from "../../terminal/failure.js";
import type { FailureDescription } from "../../terminal/failure.js";
import { Block } from "../../terminal/blocks.js";
import type { SetEnabledInvalid } from "@smolai/skit-core/library";

/** What a refused request to enable or disable says, for each reason the Library gives. */
export const setEnabledInvalid = {
  "invocation-when-disabling": "--invocation applies only when enabling a skill",
  "subject-absent": "Selected subject is absent from this Library",
  "all-with-skill": "--all requires a Collection, not one contained Skill",
  "all-with-selected-skills": "Choose either --all or selected Skills",
  "selected-skills-with-skill": "Selected Skills require a Collection",
  "selection-required": "Select a contained Skill or use --all for this Collection",
  "selected-skill-absent": "Selected Skill is absent from this Collection",
  "nothing-selected": "Choose something to enable or disable",
} satisfies Record<SetEnabledInvalid["reason"], string>;

/** The saved choice remains valid when writing installed copies stops partway through. */
export const setEnabledIncompleteFailure = (
  error: import("@smolai/skit-core/library/enable").SetEnabledIncomplete,
  describe: (
    failure: import("@smolai/skit-core/library/enable").ApplyFailure,
  ) => FailureDescription,
) => {
  const cause = describe(error.failure);
  return describeFailure({
    summary: ["Library choice was saved or already in place, but the operation did not complete."],
    details: [Block.Group({ title: "Stopped by", children: cause.explanation })],
    next: [
      ...cause.next,
      " ",
      "Inspect the saved Library choices and installed copies, resolve the reported condition, then preview and retry the change. No rollback was attempted.",
    ],
  });
};
