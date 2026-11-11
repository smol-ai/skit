import { describeFailure } from "../../terminal/failure.js";
import type { FailureDescription } from "../../terminal/failure.js";
import { Block } from "../../terminal/blocks.js";
import type { ManageSelectionInvalid, SetupStepsInvalid } from "@smolai/skit-core/library";
import type { SetupStopped } from "@smolai/skit-core/library/setup";
import { Match } from "effect";

/** Setup keeps the stopped reason intact; nested failures use their frontend's formatter. */
export const setupStoppedFailure = (
  failure: SetupStopped,
  formatFailure: (error: unknown) => FailureDescription,
) => {
  const detail = Match.value(failure.reason).pipe(
    Match.tagsExhaustive({
      EvidenceDiffers: ({ path }) => [
        Block.Note({ text: [{ code: path }, " changed after it was reviewed"] }),
      ],
      LibraryChanged: () => [Block.Note({ text: ["The Library changed while setup ran"] })],
      StepFailed: ({ error }) => formatFailure(error).explanation,
    }),
  );
  return describeFailure({
    summary: [`Setup stopped at step ${failure.reason.step + 1}`],
    details: [Block.Group({ title: "Reason", children: detail })],
    next: [
      "Nothing was rolled back. Preview undoing it with ",
      { code: "skit library undo " + failure.operationId },
      ", or run ",
      { code: "skit setup" },
      " again to review the current plan.",
    ],
  });
};

/** What a Manage selection the Library refuses says, for each reason it gives. */
export const manageSelectionInvalid = ({ skillName, reason }: ManageSelectionInvalid): string =>
  ({
    "duplicate-selection": `Duplicate Manage selection: ${skillName}`,
    "candidate-not-manageable": `${skillName} cannot be managed as it is`,
    "machine-identity-missing": `Managing ${skillName} needs this machine's identity`,
  })[reason];

/** What refused setup steps say. The Library counts steps from zero; people count from one. */
export const setupStepsInvalid = ({ reason, step = 0, path = "" }: SetupStepsInvalid): string =>
  ({
    "sync-program-missing": `Sync step ${step + 1} has no earlier recorded program`,
    "import-step-missing": `Setup step ${step + 1} takes its files from a step that imports none`,
    "removal-not-last": "Setup removes folders only after every other step",
    "path-not-normalized": `Setup removes only absolute, normalized paths: ${path}`,
    "path-in-library-storage": `Setup cannot remove the Library's own storage: ${path}`,
    "duplicate-removal": `Setup removes each folder once, and never one inside another: ${path}`,
    "undo-path-not-replaceable": `Undo cannot replace Library storage or a non-normalized path: ${path}`,
  })[reason];
