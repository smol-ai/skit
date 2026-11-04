/** Reusable setup scan, reviewed choices and apply workflow. Owners retain their state. */
export { recordDuplicateSymlinks, type ManageOptions } from "./manage-existing.js";
export { SetupStopped, applySetupPlan } from "./setup-apply.js";
export {
  InstalledSkillChange,
  InstalledSkillChangeResult,
  RepositoryPolicyResult,
  SetupApplied,
  SetupKnownSourceSelection,
  SetupLockMatch,
  SetupOnboardingCandidate,
  SetupResult,
  SetupSkillInstance,
  SetupVersionChoice,
} from "./setup-contract.js";
export {
  SetupCopySelection,
  SetupDuplicateAction,
  copyConflict,
  recommendedSetupSelection,
  setupApplyCommandLine,
  setupDuplicateActions,
  setupDuplicateChoiceRequired,
  setupReviewCopies,
  setupSourceChoiceId,
  type SetupCopyChoice,
  type SetupExplicitSelection,
  type SetupRecommendation,
  type SetupReviewCopy,
  type SetupSelectedCopy,
} from "./setup-decisions.js";
export { collectSetupEvidence, ownershipAt } from "./setup-discovery.js";
export { setupImportRequests } from "./setup-import.js";
export { changeResults } from "./setup-installed-skills.js";
export { setupExistingSelections, setupNewSelections } from "./setup-manage.js";
export { classifyOwner, classifySetupOnboarding } from "./setup-onboarding.js";
export { planSetupRemovals, setupRemovablePaths } from "./setup-removal.js";
export { openSetupReview, type SetupReview, type SetupReviewSummary } from "./setup-review.js";
export {
  SetupPlanStale,
  computeSkillsLockCompatibleHash,
  revalidateSetupPlan,
  runSetup,
  type SetupOptions,
} from "./setup.js";
export { computeSkillsShCompatibleHash } from "./skills-sh-compatible-hash.js";
export { resolveSkillsShSelectedSource } from "./skills-sh-lock-source.js";
export type { SetupCopyConflict } from "./setup-decisions.js";
export { SetupImportInvalid } from "./setup-import.js";
export { ChangeChoiceRequired } from "./setup-installed-skills.js";
export { SetupManageSelectionInvalid } from "./setup-manage.js";
export { SetupDuplicateDecisionRequired } from "./setup-review.js";
export { prepareSetupUndo } from "./setup-undo.js";
