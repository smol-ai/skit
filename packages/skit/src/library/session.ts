/** Interactive Library state, choices and reviewed transitions. Frontends own prompts and widgets. */
export { invocationOptions, type InvocationOption } from "./internal/session/invocation-option.js";
export {
  destinationLabel,
  invocationBriefing,
  invocationRowSummary,
} from "./internal/session/invocation.js";
export {
  type ScopeChoice,
  scopeKey,
  scopeChoices,
  DESTINATION_QUESTION,
  invocationEligibleScopes,
  invocationChoices,
} from "./internal/session/read-model.js";
export {
  type ScopeRow,
  type LibrarySkillRow,
  type PendingLibraryChange,
  type LibraryActionOutcome,
  type LibrarySessionState,
  libraryPolicyAfter,
  proposeLibraryEnable,
  proposeLibraryDisable,
  libraryCollectionScopes,
  proposeLibraryCollectionChange,
  proposeLibraryInvocation,
  cancelLibraryChange,
  confirmLibraryChange,
} from "./internal/session/session.js";
export type { InstallScope as Scope } from "./scope.js";
