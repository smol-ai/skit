/** Supported application surface shared by executable front ends. Import core through its
 * package boundary so all front ends use one identity for services and schemas. */
export { LibraryActor, libraryStoreLayer, skitLayer } from "@smolai/skit-core";
export { libraryApplicationLayer } from "./layers.js";
export { openLibraryView } from "./library-view.js";
export {
  openLibrarySession,
  readLibrarySkillContent,
  refreshLibrarySession,
  proposeLibraryEnable,
  proposeLibraryCollectionChange,
  libraryCollectionScopes,
  proposeLibraryDisable,
  proposeLibraryInvocation,
  confirmLibraryChange,
  cancelLibraryChange,
  type LibraryActionOutcome,
  type ScopeRow,
  type LibrarySessionState,
  type LibrarySkillRow,
  type PendingLibraryChange,
} from "./session.js";
export { planUpdates, updateSubjects, updateExitCode } from "./update.js";
export {
  LibraryProgress,
  libraryProgressLayer,
  silentLibraryProgressLayer,
  type LibraryProgressEvent,
  type LibraryProgressStage,
  type LibraryProgressCompletion,
} from "./progress.js";
export {
  DESTINATION_QUESTION,
  destinationLabel,
  invocationChoices,
  invocationBriefing,
  invocationEligibleScopes,
  invocationRowSummary,
  scopeChoices,
  scopeKey,
  type Scope,
} from "./read-model.js";
export type { InvocationOption } from "../invocation/policy.js";

export {
  SkitConfiguration,
  resolveSkitConfiguration,
  skitConfigurationLayer,
  type ResolvedSkitConfiguration,
} from "../configuration/skit-configuration.js";

export {
  applySetEnabledPlan,
  SetEnabledIncomplete,
  openSetEnabledSession,
  type SetEnabledIntent,
  type EnabledCollection,
  type SetEnabledPlan,
} from "./set-enabled.js";
