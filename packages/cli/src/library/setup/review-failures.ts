import { describeFailure } from "../../terminal/failure.js";
import {
  SetupReviewFailure,
  type SetupReviewInputReason,
  SetupManageSelectionInvalid,
} from "@smolai/skit-core/library/setup/failures";
import { Match } from "effect";

const manageReason = ({ reason }: SetupManageSelectionInvalid): string =>
  ({
    "duplicate-selection": "it was selected more than once",
    "candidate-not-found": "the selected folder is no longer in the scan",
    "candidate-not-manageable": "the selected folder cannot be managed in its current state",
    "candidate-not-bindable": "the selected folder cannot be matched to a Library Skill",
    "source-not-candidate": "the chosen source does not belong to this scanned Skill",
    "content-identity-missing": "the scan has no content hash for this folder",
    "path-not-projection-target":
      "the selected folder is outside the configured installation folders",
    "duplicate-action-required": "choose how to handle its existing copies first",
    "keep-both-replaces-link": "keeping both copies would replace an existing symbolic link",
    "aliases-not-retirable": "the reviewed symbolic links cannot be safely removed",
    "copies-not-preservable": "the reviewed copies cannot be safely backed up",
  })[reason];

const reviewInputMessage = Match.type<SetupReviewInputReason>().pipe(
  Match.tagsExhaustive({
    ActionUnavailable: () => "The selected setup action is unavailable in this scan.",
    DuplicateVersionChoices: ({ skillIds }) =>
      `More than one active version was selected for: ${skillIds.join(", ")}.`,
    VersionUnavailable: ({ skillId, version, path }) =>
      `The selected ${version} version of ${skillId}${path === undefined ? "" : ` at ${path}`} is unavailable in this scan.`,
    DecisionCountMismatch: ({ selected, decisions }) =>
      `Setup selected ${selected} copies but received ${decisions} copy decisions.`,
    CopyDecisionCountMismatch: ({ name, path, decisions }) =>
      `Setup needs one decision for ${name} at ${path}; it received ${decisions}.`,
    KeepBothReplacesLink: ({ name, path }) =>
      `Cannot keep both copies of ${name}: ${path} is a symbolic link at the installation destination.`,
    CopiesNotPreservable: ({ name, path }) =>
      `Cannot back up duplicate copies of ${name} at ${path}: the scan did not find eligible equal global copies.`,
    AliasesNotRetirable: ({ name, path }) =>
      `Cannot retire aliases for ${name} at ${path}: the duplicate copies are not all individual symbolic links.`,
    SourceUnavailable: ({ key }) => `Source ${key} is unavailable in this scan.`,
    RecommendedCopyMissing: ({ name, path }) =>
      `The recommended copy of ${name} at ${path} is missing from this scan.`,
    ExistingSkillUnavailable: ({ skillId }) => `Skill ${skillId} has no reviewed change to apply.`,
    SourceIdUnavailable: ({ sourceId }) => `Source ${sourceId} is unavailable in this scan.`,
    CopyUnavailable: ({ path }) =>
      `The copy at ${path} is unavailable for enablement in this scan.`,
    RemovalUnavailable: ({ path }) =>
      `The copy at ${path} is unavailable for removal in this scan.`,
    RemovalAlsoEnabled: ({ path }) =>
      `The copy at ${path} was selected for both removal and enablement.`,
    ComparisonCopyUnavailable: ({ path }) =>
      `The copy at ${path} is unavailable for comparison in this scan.`,
    ComparisonEmpty: () => "No copies were selected for comparison.",
    ComparisonIdentityMissing: ({ path }) =>
      `The setup scan has no content hash for the copy at ${path}.`,
    ComparisonContentChanged: ({ path }) => `The copy at ${path} changed after setup scanned it.`,
    LibraryVersionUnavailable: ({ skillId }) =>
      `Skill ${skillId} has no Library Version alternative in this scan.`,
    CurrentVersionUnavailable: ({ path }) =>
      `The copy at ${path} has no current-version alternative in this scan.`,
  }),
);

export const setupReviewFailure = Match.type<SetupReviewFailure>().pipe(
  Match.tagsExhaustive({
    "Library.UpdateSelectionMissing": () =>
      describeFailure({
        summary: ["This older setup did not record which Skills were selected for update."],
        next: [
          "Preview undoing this setup, or run ",
          { code: "skit setup" },
          " again to review the current changes.",
        ],
      }),
    SetupReviewInputInvalid: ({ reason }) =>
      describeFailure({
        summary: [reviewInputMessage(reason)],
        next: ["Run ", { code: "skit setup" }, " again and review the available choices."],
      }),
    SetupPlanStale: () =>
      describeFailure({
        summary: ["The setup plan changed after it was reviewed."],
        next: [
          "Run ",
          { code: "skit setup" },
          " again and review the current plan; ",
          { code: "skit setup --json" },
          " reports its planId.",
        ],
      }),
    SetupManageSelectionInvalid: (failure) =>
      describeFailure({
        summary: [`Cannot manage ${failure.skillName} during setup: ${manageReason(failure)}`],
        next: ["Run ", { code: "skit setup" }, " again and review the current plan."],
      }),
    SetupDuplicateDecisionRequired: ({ names, keepBoth, retirable }) =>
      describeFailure({
        summary: [`Enabling ${names.join(", ")} would create another copy agents already see`],
        next: [
          "Choose a value for ",
          { code: "--duplicates" },
          ": ",
          { code: "import-only" },
          " keeps the copies in the Library without enabling them",
          ...(keepBoth
            ? ["; ", { code: "keep-both" }, " enables them alongside the existing copies"]
            : []),
          ...(retirable
            ? [
                "; ",
                { code: "back-up-symlinks" },
                " enables them and moves redundant symlinks into recovery",
              ]
            : []),
          ".",
        ],
      }),
  }),
);
