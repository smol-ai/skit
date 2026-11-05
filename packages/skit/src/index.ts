// Type-only failure and service aliases preserve portable inferred consumer declarations.
export { readCodexSkills } from "./harnesses/skill-listing/codex-discovery.js";
export { largeListingEntries, ListingBudget } from "./harnesses/skill-listing/contracts.js";
export { readListingBudgets } from "./harnesses/skill-listing/discovery.js";
export { readClaudeListingSnapshot } from "./harnesses/skill-listing/claude.js";
export { readCodexListingBudget } from "./harnesses/skill-listing/codex.js";
export { estimateCodexListing } from "./harnesses/skill-listing/codex-allocation.js";
export { BuildInfo } from "./shared/build-info.js";
export {
  parseContract,
  SkitContractError,
  serverDiscoverySchema,
} from "./api/consumer-contracts.js";
export {
  AuthorSkitSummary,
  AuthorSkitListResponse,
  AuthorSkitDeleteResponse,
  releasePublishRequestSchema,
  releasePublishResponseSchema,
  type ReleasePublishResponse,
} from "./api/authoring-contracts.js";
export { skillFindingFingerprint, auditSkill, evaluateSkillAudit } from "./auditing/skill-audit.js";
export {
  COLLECTION_CONTROL_DIRECTORY,
  AUTHOR_WORKSPACE_METADATA_FILE,
} from "./artifact/control-files.js";

export { OwnershipMarker } from "./installed-skills/ownership-marker.js";
export {
  SkillAudit,
  SkillAssessmentDecision,
  SkillSecurityReview,
} from "./auditing/skill-contracts.js";
export { Hash } from "./shared/hash.js";
export { HarnessName } from "./harnesses/contracts.js";
export { InvocationPolicy } from "./artifact/invocation-policy.js";
export { InstallDestination } from "./installed-skills/destination.js";
export { InstallScope } from "./library/scope.js";
export { SkitValidationDiagnostic } from "./artifact/validation-diagnostic.js";

export {
  errorMessage,
  type FailureCode,
  FailureTypeId,
  type SkitFailure,
  isSkitFailure,
} from "./shared/failure.js";
export {
  ReadmeFrontmatterMissing,
  DescriptorMalformed,
  SkitValidationFailed,
  type DescriptorFailure,
} from "./artifact/failures.js";
export { DirectSkillDocumentInvalid, NoSkitDescriptorFound } from "./sources/failures.js";
export {
  SkillsDirectoryNotWritable,
  InstalledSkillFileMissing,
} from "./installed-skills/failures.js";
export { ImportContentInvalid, InvalidLibraryState } from "./library/failures.js";
export { HarnessMetadataInvalid } from "./harnesses/metadata-failures.js";
export {
  type HarnessDocumentationSource,
  type SkillsDirectory,
  type HarnessProfile,
  type SkillsDirectoryOverrides,
} from "./harnesses/contracts.js";
export {
  harnessProfile,
  harnessProfileIds,
  skillsDirectory,
  resolveSkillsDirectory,
  installSkillsDirectory,
} from "./harnesses/catalog.js";
export { harnessDrivers } from "./harnesses/drivers.js";
export { canonicalJson } from "./shared/json.js";
export { evaluateSkillFrontmatter } from "./harnesses/frontmatter.js";

export {
  assessInvocationConformance,
  resolveDeclaredInvocation,
} from "./invocation/conformance.js";
export {
  isAuthorWorkspace,
  generateInvocationMetadata,
  InvocationMetadataGeneration,
  type InvocationMetadataGenerationFailure,
} from "./authoring/invocation/generation.js";
export { defaultSkillsRoot } from "./harnesses/default-roots.js";
export { installDestinationHarnesses } from "./harnesses/install-destinations.js";
export { libraryDoctorReport, LibraryDoctorReport } from "./library/inventory/doctor-report.js";
export { createSkitArchive } from "./authoring/archive.js";
export { type InitSkitResult, initSkit } from "./authoring/scaffold.js";
export { LinkStat } from "./platform/link-stat.js";
export { type FileLockBusy, type FileLockFailed, acquireFileLock } from "./platform/file-lock.js";
export {
  type SourceProcessResult,
  type SourceProcessFailure,
  SourceProcess,
  sourceProcessLayer,
} from "./platform/source-process.js";
export { type SkitServices, skitLayer } from "./platform/layer.js";
export { pathIsWithin } from "./platform/path-identity.js";
export { applyInvocationPolicy } from "./installed-skills/policy.js";
export {
  type InstalledSkillFailure,
  inspectOwnershipMarker,
  prepareInstalledSkillRebuild,
  type ManageApproval,
} from "./installed-skills/files.js";

export {
  makePnpmSkillCheck,
  pnpmSkillOwner,
  type PnpmSkillManaged,
  leavePnpmSkill,
} from "./installed-skills/pnpm-skills.js";

export {
  hashParts,
  hashInstalledSkillFiles,
  parseSkitReadme,
  parseSkitConfig,
} from "./artifact/descriptor.js";
export {
  readSkitDescriptor,
  deterministicTreeHash,
  validateSkitDirectory,
} from "./artifact/skit.js";
export {
  parseSkitSource,
  sourceLocator,
  resolveSkitSource,
  type PluginManifestInvalid,
  type PluginSkillConflict,
  SourceDiscoveryDiagnostic,
  type ParseSourceFailure,
  type ResolvedSkitSource,
  type CommandFailed,
  type SourcePolicyViolation,
} from "./sources/resolve.js";
export { type TreeRequirements } from "./platform/tree-requirements.js";
export { TreeError } from "./shared/tree-error.js";
export {
  walkTree,
  inspectNormalizedTree,
  scanAuthorTree,
  walkAuthorTree,
} from "./artifact/tree.js";
export { TreeFile, TreeEntry } from "./artifact/tree-entry.js";
export { type AuthorIgnoreRepository } from "./artifact/plain-author-ignore.js";

export type { LibraryLayerError, LibraryStateReadError } from "./library/library.js";
export { scanInventory, type InventoryScanRoot } from "./library/inventory/refresh.js";
export { collectionVersionPath } from "./library/collection-version.js";
export {
  SkitSource,
  SkillsShLockFileEntry,
  SkillVersion,
  Skill,
  Collection,
  CollectionVersion,
  Import,
  importCanBeRefetched,
  librarySnapshotDigests,
  Enabled,
  mergeEnabled,
  sourceImports,
  currentCollectionSkills,
  currentSkillVersion,
  enabledSkillIds,
  LibraryManifest,
  currentLibraryManifest,
  SnapshotArchive,
} from "./library/library-contracts.js";

export {
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  globalEnabled,
  enabledAt,
  currentLibraryState,
  emptyLibraryState,
  libraryStateRevision,
  LibraryInventory,
  libraryManifestFromLocalState,
  AbsoluteDevicePath,
  InstalledSkill,
  DeviceSkillSelection,
} from "./library/library-state.js";
export { setupIntent } from "./library/setup.js";
export { prepareDeviceInstallation, withDeviceSkillSelection } from "./library/enabled.js";
export { RestoreInvalid, SourceRestoreInvalid } from "./library/library.js";
export { planCollectionVersions } from "./library/collection-version-plan.js";
export {
  type RestorePhase,
  type RestoreTick,
  type RestoreProgress,
} from "./library/restore-progress.js";

export {
  type CollectionRemovalMissing,
  type SkillRemovalRequiresCollection,
} from "./library/installation/remove.js";
export { type SkillMaterializationInvalid } from "./library/installed-skill-hash.js";
export {
  type ImportRequestInvalid,
  type InstalledSkillChanged,
} from "./library/import-collection.js";
export type {
  ImportRequestSkill,
  ImportRequest,
  ImportedCollection,
  ImportedEdit,
} from "./library/import-collection.js";
export { type InstalledSkillInvalid } from "./library/installation/install-enabled.js";
export { readSnapshotArchive } from "./library/snapshot-archive.js";
export {
  CollectionId,
  SkillId,
  SkillVersionId,
  makeCollectionId,
  makeSkillId,
  makeSkillVersionId,
  makeCollectionVersionId,
  makeImportId,
  makeInstalledSkillId,
  makeMachineId,
  makeOperationId,
  LegacyMachineId,
  migratedMachineId,
} from "./library/entity-ids.js";
export { MachineDocumentJson } from "./library/machine-document.js";
export { LibraryAuditEvent, type LibraryAuditInvalid } from "./library/audit/audit-log.js";

export { errnoOf, isErrno } from "./shared/errno.js";

export {
  UsageHarness,
  UsageRow,
  UsageReport,
  type InvalidUsageOptions,
  type UsageRoot,
  type UsageOptions,
} from "./library/usage/contracts.js";
export { scanUsage } from "./library/usage/scanner.js";

export * as MachineSettings from "./library/machine-settings.js";
export * as Merge from "./sync/merge.js";
export * as History from "./history/history.js";
export * as Sync from "./sync/sync.js";
export { mergeAuthorTree, conflictKind } from "./author/merge/files.js";
export { type Unusable as MachineSettingsUnusable } from "./library/machine-settings.js";

export { InstalledSkills } from "./library/installed-skills.js";
export * as InstalledSkillStatus from "./library/installed-skill-status.js";
export { Library } from "./library/library.js";
export {
  type LibrarySubjectNotFound,
  type LibrarySubjectAmbiguous,
  librarySubjects,
  matchingLibrarySubjects,
} from "./library/subject-resolution.js";

export {
  type AddNoSkills,
  leaveResolvedPnpmSkills,
  describeSourceSkills,
  inspectResolvedSource,
} from "./library/source-inspection.js";

export { observePathEvidence, recoveryFingerprint } from "./library/folder-evidence.js";
export type { ApplyError as LibraryApplyError } from "./library/library.js";

export {
  type InstalledSkillWouldReplaceLink,
  type InstalledSkillWouldDuplicate,
} from "./library/library.js";

export { type DuplicateScanIncomplete } from "./library/installed-skills.js";
export { type InvalidIntent, StalePlan, type DestinationsIncomplete } from "./library/library.js";

// Recovery vocabulary is public; reading and mutating recovery evidence belongs to Library.
export { RecoveryInspection, type RecoveryInvalid } from "./library/recovery-facts.js";

export { OptionCombinationInvalid } from "./shared/input-failures.js";

export {
  SkitConfiguration,
  resolveSkitConfiguration,
  configurationForHome,
  skitConfigurationLayer,
  type ResolvedSkitConfiguration,
} from "./platform/configuration.js";

export { normalizeLibraryManifest } from "./library/manifest.js";

export { type ManageStopped, type SyncStopped } from "./library/library.js";
export type { StoredSyncProgram } from "./library/store/state-schema.js";

export * as HomeLock from "./platform/home-lock.js";
