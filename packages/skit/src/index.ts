export * from "./harnesses/skill-listing/codex-discovery.js";
export * from "./harnesses/skill-listing/contracts.js";
export * from "./harnesses/skill-listing/discovery.js";
export * from "./harnesses/skill-listing/claude.js";
export * from "./harnesses/skill-listing/codex.js";
export * from "./harnesses/skill-listing/codex-allocation.js";
export * from "./models/model-context-windows.js";
export * from "./build-info.js";
export * from "./distribution/api-contracts.js";
export * from "./authoring/api-contracts.js";
export * from "./auditing/skill-audit.js";
export * from "./artifact/control-files.js";
export * from "./contracts.js";
export * from "./shared/failure.js";
export * from "./failures.js";
export * from "./harnesses/contracts.js";
export * from "./harnesses/catalog.js";
export * from "./harnesses/drivers.js";
export * from "./shared/json.js";
export * from "./harnesses/frontmatter.js";
export * from "./harnesses/invocation-metadata.js";
export * from "./invocation/conformance.js";
export * from "./authoring/invocation/generation.js";
export * from "./harnesses/default-roots.js";
export * from "./harnesses/install-destinations.js";
export * from "./library/inventory/doctor-report.js";
export * from "./authoring/archive.js";
export * from "./authoring/scaffold.js";
export * from "./platform/link-stat.js";
export * from "./platform/file-lock.js";
export * from "./platform/source-process.js";
export * from "./platform/layer.js";
export * from "./platform/path-identity.js";
export * from "./install/policy.js";
export {
  InstalledSkillFailure,
  inspectOwnershipMarker,
  inspectInstalledSkill,
  installedSkillDisplaced,
  installedSkillName,
  prepareInstalledSkillRebuild,
  type InstalledSkillMutationError,
  type ManageApproval,
} from "./install/files.js";
export { inspectInstalledSkillBackups } from "./install/backups.js";
export { copyLocalTree } from "./platform/copy-tree.js";
export { ensureSkillsDirectoryWritable } from "./install/writable.js";
export * from "./install/pnpm-skills.js";
export { discoveryPathExcluded } from "./sources/discovery-exclusions.js";
export * from "./distribution/registry-identity.js";
export * from "./artifact/descriptor.js";
export * from "./artifact/skit.js";
export * from "./artifact/tree-hasher.js";
export * from "./sources/resolve.js";
export * from "./platform/tree-requirements.js";
export * from "./shared/tree-error.js";
export * from "./artifact/tree.js";
export * from "./artifact/tree-entry.js";
export {
  AuthorIgnoreRepository,
  authorIgnoreRepositoryLayer,
} from "./artifact/plain-author-ignore.js";

export {
  LibraryActor,
  type LibraryLayerError,
  type LibraryStateReadError,
  type LibraryStateWriteError,
} from "./library/store/library-store.js";
export { withHomeLock } from "./library/store/writer-lock.js";
// Records written beside v9 state (setup and undo evidence) migrate through the same shapes.
export {
  CollectionVersionV7,
  ImportV7,
  importFromV7,
  collectionVersionFromV7,
} from "./library/store/manifest-v7.js";
export {
  DeviceBindingV9,
  DeviceSkillSelectionV9,
  InstalledSkillV9,
  RepositoryBindingV9,
  deviceSelectionFromV9,
  globalFromV9,
  installedSkillFromV9,
  repositoryFromV9,
} from "./library/store/state-schema-v9.js";
export * from "./library/inventory/refresh.js";

export {
  originalTreeHash,
  collectionVersionPath,
  writeCollectionVersion,
} from "./library/collection-version.js";
export * from "./library/library-contracts.js";
export * from "./library/source-identity.js";
export { skillsShLockFileEntry } from "./library/skills-sh-lock-file.js";
export * from "./library/library-state.js";
export * from "./library/setup-intent.js";
export * from "./library/enabled.js";
export * from "./library/library-restore.js";
export * from "./library/collection-version-plan.js";
export * from "./library/restore-progress.js";
export * from "./library/installation/uninstall.js";
export * from "./library/installation/remove.js";
export * from "./library/installed-skill-hash.js";
export * from "./library/import-collection.js";
export * from "./library/installation/install-enabled.js";
export { installedSkillSource } from "./library/installation/installed-skill-source.js";
export * from "./library/snapshot-archive.js";
export * from "./library/entity-ids.js";
export * from "./library/machine-document.js";
export {
  LibraryAuditEvent,
  LibraryAuditChange,
  LibraryAuditInvalid,
  type LibraryAuditDraft,
} from "./library/audit/audit-log.js";
export {
  writeRawAtomic,
  writeJsonAtomic,
  writeJsonExclusive,
  syncPaths,
} from "./platform/atomic-write.js";
export { sha256Hash, hashHex } from "./shared/hash.js";
export { isCanonicalRelativePath, parentDirectories } from "./shared/relative-path.js";
export * from "./usage/contracts.js";
export { SkillUsage, skillUsageLayer } from "./usage/scanner.js";

export * as MachineSettings from "./library/machine-settings.js";
export * as Merge from "./merge/merge.js";
export * as History from "./history/history.js";
export * as Sync from "./sync/sync.js";
export { mergeAuthorTree, conflictKind } from "./merge/files.js";
export {
  Unusable as MachineSettingsUnusable,
  type Settings as MachineSettingsSnapshot,
} from "./library/machine-settings.js";

export * as InstalledSkillFiles from "./install/files.js";
export * as InstalledSkillBackups from "./install/backups.js";

export { InstalledSkills } from "./library/installed-skills.js";
export * as InstalledSkillStatus from "./library/installed-skill-status.js";
export { Library } from "./library/library.js";
export * from "./library/subject-resolution.js";
export * from "./library/duplicates.js";
export * from "./library/source-inspection.js";
export {
  ReviewedChangeDiffers,
  changeWrites,
  updateInstalledSkills,
  type ReviewedChange,
  type UpdateChoice,
  type UpdatedCopy,
} from "./library/installed-update.js";
export {
  incompleteManageWarning,
  manageBlockers,
  planManage,
  type ManagePlan,
} from "./library/manage-plan.js";
export { observePathEvidence, recoveryFingerprint } from "./library/folder-evidence.js";
export type {
  PlanError as LibraryPlanError,
  ApplyError as LibraryApplyError,
} from "./library/library.js";

export { InstalledSkillWouldReplaceLink, InstalledSkillWouldDuplicate } from "./library/library.js";

export { DuplicateScanIncomplete } from "./library/installed-skills.js";
export { InvalidIntent, StalePlan, DestinationsIncomplete } from "./library/library.js";

// Existing recovery callers migrate to Library operations one at a time. These compatibility
// exports keep the same behavior; setup undo itself calls only the owner.
export {
  RecoveryInspection,
  recoveryOperationDirectory,
  prepareRecoveryMoves,
  inspectRecoveryOperation,
  listRecoveryOperations,
  prepareRecoveryRestore,
} from "./library/internal/recovery/moves.js";
export {
  RecoveryInvalid,
  recoveryFingerprint as setupRecoveryFingerprint,
} from "./library/internal/recovery/evidence.js";
export { readSkillPathDetails } from "./library/internal/setup/journal.js";

export { OptionCombinationInvalid } from "./shared/input-failures.js";

export {
  SkitConfiguration,
  resolveSkitConfiguration,
  configurationForHome,
  skitConfigurationLayer,
  type ResolvedSkitConfiguration,
} from "./platform/configuration.js";

export { normalizeLibraryManifest } from "./library/manifest.js";

export { SyncStopped } from "./library/internal/sync/sync.js";
export type {
  SyncProgram,
  StoredSyncProgram,
  SyncPublication,
} from "./library/store/state-schema.js";
