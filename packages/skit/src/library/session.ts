/** Shared Library choices/read models. Frontends own prompts, widgets and output. */
export { readDescriptionLoad } from "./internal/session/description-load.js";
export { invocationOptions, type InvocationOption } from "./internal/session/invocation-option.js";
export type { AuthorInvocationRead } from "./internal/session/invocation-source.js";
export {
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
} from "./internal/session/set-enabled.js";
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
  enabledCollections,
} from "./internal/session/set-enabled-request.js";
export {
  type SetEnabledConfiguration,
  type SetEnabledPlan,
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

export type { InstallScope as Scope } from "./scope.js";

export { openRemoveSession } from "./internal/session/remove.js";

export { openEditImport, EditImportMissing } from "./internal/session/edit.js";
export { EditImportPlan, EditImportResult } from "./internal/session/edit-contract.js";

export { sourceFromUpstream } from "./internal/session/upstream-source.js";

export type {
  SkillsShUpdateMember,
  SkillsShUpdateStatus,
} from "./internal/session/skills-sh-update-check.js";

export {
  type SourceInspection,
  type LibraryProgressSubject,
  type LibraryProgressStage,
  type LibraryProgressCompletion,
  type LibraryProgressReporter,
} from "./internal/session/source-updates.js";
export { updateSources, type SourceUpdateAdapters } from "./internal/session/update-sources.js";

export { SyncConflictDetail } from "./internal/sync/conflict.js";
export { resolveSyncInstalledSkillCollisions } from "./internal/sync/collisions.js";
export {
  previewSyncInstalledSkills,
  type SyncInstalledSkillsPreview,
} from "./internal/sync/installed-skills.js";

export { alignLibrary, aliasManifest, aliasDevice } from "./internal/sync/alignment.js";

// Inferred consumer declarations require these failure names.
export type { EditImportAmbiguous } from "./internal/session/edit.js";
export type { GitInspectionFailed } from "./internal/session/skills-sh-git-evidence.js";
export type { CollectionNotUpdatable } from "./internal/session/source-updates.js";
