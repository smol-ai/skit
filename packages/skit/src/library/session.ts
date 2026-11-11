/** Interactive Library state, choices and reviewed transitions. Frontends own prompts and widgets. */
export { invocationOptions, type InvocationOption } from "./internal/session/invocation-option.js";
export { InvocationReadModel } from "./internal/session/invocation.js";
export {
  type ScopeChoice,
  scopeKey,
  scopeChoices,
  invocationEligibleScopes,
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
export type { InstallScope } from "./scope.js";

export { AuthorInvocationFailure, InvocationUnavailable } from "./invocation-failure.js";
