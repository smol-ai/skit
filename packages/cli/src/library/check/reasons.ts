import { SkillsShUpdateReason, type SkillsShUpdateMember } from "@smolai/skit-core/library";
import { errorMessage } from "@smolai/skit-core/shared";
import { Block } from "../../terminal/blocks.js";
import { updateFailure } from "../update-failures.js";

export const skillsShStatus = {
  current: "Up to date",
  "update-available": "Update available",
  "removed-upstream": "Removed from the upstream source",
  "lock-stale": "The lock file differs from the Library copy and upstream",
  "differs-from-lock-and-upstream": "The Library copy differs from the lock file and upstream",
  unverifiable: "Could not verify updates",
  "not-applicable": "Git update checks do not apply",
} satisfies Record<SkillsShUpdateMember["status"], string>;

export const skillsShReason = (reason: SkillsShUpdateReason): readonly Block[] =>
  SkillsShUpdateReason.match(reason, {
    WellKnownSource: () => [Block.Note({ text: ["This Skill comes from a well-known URL."] })],
    GitSourceMissing: () => [
      Block.Note({ text: ["The lock file has no Git source URL for this Skill."] }),
    ],
    MirrorUnavailable: ({ failure }) => [
      Block.Note({ text: ["Could not prepare the local Git mirror for this check."] }),
      ...(failure._tag === "SkillsSh.GitInspectionFailed"
        ? updateFailure(failure).explanation
        : [Block.Note({ text: [errorMessage(failure)] })]),
    ],
    RefUnavailable: ({ ref, failure }) => [
      Block.Note({ text: ["Could not resolve the selected Git ref ", { code: ref }, "."] }),
      ...updateFailure(failure).explanation,
    ],
    GitEvidenceUnavailable: ({ failure }) => [
      Block.Note({ text: ["Could not inspect the Skill's Git history."] }),
      ...updateFailure(failure).explanation,
    ],
    LockIncomplete: ({ missing }) => [
      Block.Note({
        text: [
          `The lock file is missing ${missing.map((field) => (field === "skill-path" ? "the Skill path" : "a usable hash")).join(" and ")}.`,
        ],
      }),
    ],
    BaselineNotFound: ({ hashKind, ref }) => [
      Block.Note({
        text: [
          `The lock file's ${hashKind === "skillFolderHash" ? "Git tree hash" : "content hash"} was not found in the searched history of `,
          { code: ref },
          ".",
        ],
      }),
    ],
    TreeHashCannotVerifyOriginalBytes: () => [
      Block.Note({
        text: [
          "The lock file records a Git tree hash. It cannot verify the Skill files in the Library.",
        ],
      }),
    ],
    OriginalBytesUnavailable: ({ failures }) => [
      Block.Note({ text: ["The Skill files in the Library could not be read for this check."] }),
      ...failures.map((failure) => Block.Note({ text: [errorMessage(failure)] })),
    ],
  });
