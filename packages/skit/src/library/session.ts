/** Shared Library choices/read models. Frontends own prompts, widgets and output. */
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
  type SetEnabledIntent,
  type EnabledCollection,
} from "./internal/session/set-enabled-request.js";
export {
  type SetEnabledConfiguration,
  type SetEnabledPlan,
  SetEnabledIncomplete,
  openSetEnabledSession,
  planSetEnabled,
  applySetEnabledPlan,
} from "./internal/session/set-enabled.js";
export {
  SkillMetadata,
  readSkillPreviews,
  readLibrarySkillMetadata,
} from "./internal/session/skill-metadata.js";

export type { InstallScope as Scope } from "./scope.js";

export { openRemoveSession } from "./internal/session/remove.js";

export { openEditImport, EditImportMissing } from "./internal/session/edit.js";
export { EditImportPlan, EditImportResult } from "./internal/session/edit-contract.js";

export { sourceFromUpstream } from "./internal/session/upstream-source.js";

export {
  type LibraryProgressStage,
  type LibraryProgressCompletion,
  type LibraryProgressReporter,
} from "./internal/session/source-updates.js";
export { updateSources } from "./internal/session/update-sources.js";

export { SyncConflictDetail } from "./internal/sync/conflict.js";
export { syncLibrary } from "./internal/sync/library-sync.js";
export { type SyncPhase, type SyncProgress } from "./internal/sync/progress.js";
export {
  listLibraryRecovery,
  inspectLibraryRecovery,
  openRecoveryRestore,
} from "./internal/session/recovery.js";

// Inferred consumer declarations require these failure names.
export type { EditImportAmbiguous } from "./internal/session/edit.js";
export type { GitInspectionFailed } from "./internal/session/skills-sh-git-evidence.js";
export type { CollectionNotUpdatable } from "./internal/session/source-updates.js";

export type { SelectionError } from "./internal/session/set-enabled.js";

export type { LibraryChangeSelection } from "./internal/session/set-enabled.js";

export type { SkillsShUpdateMember } from "./internal/session/skills-sh-update-check.js";

export { openSyncSession, SyncLocalChanged } from "./internal/sync/session.js";
export { SyncChanges } from "./sync-changes.js";

// Canonical read-query errors keep inferred frontend declarations portable.
export type { LibrarySubjectNotFound, LibrarySubjectAmbiguous } from "./subject-resolution.js";

export type { WorkspaceClaim } from "./internal/session/workspace-claims.js";

export {
  readLibraryList,
  readLibraryWorkspaceClaims,
  readInstalledSkills,
  readLibraryManifest,
  readSkillsShCollectionIds,
  readLibraryDescriptionLoad,
  reviewLibrarySecurity,
  readLibraryHistory,
  acceptLibrarySecurityFinding,
  checkLibrarySubjects,
  previewLibrarySourceUpdates,
} from "./internal/session/queries.js";
