/** Supported application surface shared by executable front ends. Import core through its
 * package boundary so all front ends use one identity for services and schemas. */
export { LibraryActor, libraryStoreLayer, skitLayer } from "@smolai/skit-core";
export { libraryApplicationLayer } from "./layers.js";
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
  type LibraryBindingRow,
  type LibrarySessionState,
  type LibrarySkillRow,
  type PendingLibraryChange,
} from "./session.js";
export { planUpdatesEffect, updateSubjectsEffect, updateExitCode } from "./update.js";
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
  invocationEligibleBindings,
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
  previewBindingChanges,
  applyBindingChanges,
  openBindingChangeSelection,
  type BindingChangeRequest,
  type BindingChangePlan,
} from "./binding-changes.js";
