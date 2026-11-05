// The words interactive setup shows, in the order it asks. The steps are fixed before setup scans
// anything, so "Step 2 of 3" means the same thing from the overview to the final confirmation; a
// step with nothing to decide says so instead of disappearing from the count announced up front.

export const setupStepTitles = {
  repositories: "Choose repositories to scan",
  collections: "Choose skills.sh collections to add",
  skills: "Review other installed skills and copies",
  confirm: "Review and confirm changes",
} as const;

export type SetupStepKey = keyof typeof setupStepTitles;

export interface SetupStep {
  readonly index: number;
  readonly total: number;
  readonly title: string;
}

export interface SetupStepPlan {
  readonly overview: string;
  readonly step: (key: SetupStepKey) => SetupStep;
}

export const setupOverviewTitle = "Setup will walk through:";

/** Repositories are only discovered under a work dir given for this run. */
export const setupStepPlan = (input: { readonly scanRepositories: boolean }): SetupStepPlan => {
  const keys = (Object.keys(setupStepTitles) as SetupStepKey[]).filter(
    (key) => key !== "repositories" || input.scanRepositories,
  );
  return {
    overview: [
      ...keys.map((key, index) => `  ${index + 1}. ${setupStepTitles[key]}`),
      "",
      "Nothing is imported or removed until you confirm.",
    ].join("\n"),
    step: (key) => ({
      index: keys.indexOf(key) + 1,
      total: keys.length,
      title: setupStepTitles[key],
    }),
  };
};

export const setupPrompts = {
  repositories: "Select repositories to scan",
  collections: "Select skills.sh collections to add",
  skills: "Choose a copy to add, or mark Remove",
  confirm: "Apply these changes?",
} as const;
