/** Shared Library choices/read models. Frontends own prompts, widgets and output. */
export { readDescriptionLoad } from "./internal/session/description-load.js";
export { invocationOptions, type InvocationOption } from "./internal/session/invocation-option.js";
export type { AuthorInvocationRead } from "./internal/session/invocation-source.js";
export {
  AuthorInvocation,
  InvocationReadModel,
  policyLabel,
  policyExplanation,
  authorPolicyLabel,
  destinationLabel,
  invocationReadModel,
  type InvocationPolicyChoice,
  invocationPolicyChoices,
  invocationBriefing,
  invocationRowSummary,
} from "./internal/session/invocation.js";
export {
  type SelectionError,
  type SelectionRequirements,
  type LibraryChangeSelection,
} from "./internal/session/library-changes.js";
export { libraryView, openLibraryView } from "./internal/session/library-view.js";
export {
  type ScopeChoice,
  type InvocationScopeRow,
  scopeKey,
  scopeChoices,
  DESTINATION_QUESTION,
  invocationEligibleScopes,
  type InvocationChoice,
  invocationChoices,
  scopeRowLabel,
} from "./internal/session/read-model.js";
export {
  type ScopeRow,
  type LibrarySkillRow,
  type PreviewFacts,
  type PendingLibraryChange,
  type LibraryActionOutcome,
  type LibrarySessionState,
  openLibrarySession,
  readLibrarySkillContent,
  libraryPolicyAfter,
  proposeLibraryEnable,
  proposeLibraryDisable,
  libraryCollectionScopes,
  proposeLibraryCollectionChange,
  proposeLibraryInvocation,
  cancelLibraryChange,
  confirmLibraryChange,
} from "./internal/session/session.js";
export { SetEnabledChange, SetEnabledResult } from "./internal/session/set-enabled-contract.js";
export {
  type SetEnabledRequest,
  calculateSetEnabled,
  type SetEnabledIntent,
  type EnabledCollection,
  sameInstallScope,
  uniqueInstallScopes,
  enabledCollections,
  expandSetEnabledIntent,
} from "./internal/session/set-enabled-request.js";
export {
  type SetEnabledConfiguration,
  type SetEnabledPlan,
  SetEnabledStale,
  SetEnabledIncomplete,
  openSetEnabledSession,
  type SetEnabledSession,
  planSetEnabled,
  applySetEnabledPlan,
} from "./internal/session/set-enabled.js";
export {
  SkillMetadata,
  skillModificationTime,
  readLibrarySkillMetadata,
} from "./internal/session/skill-metadata.js";

export type { InstallScope as Scope } from "../vocabulary.js";
