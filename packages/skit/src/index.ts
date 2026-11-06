// Aggregate still used by remaining tests and the explicitly deferred TUI. Remove after those callers migrate.

export { ListingBudget } from "./harnesses/skill-listing/contracts.js";
export { readListingBudgets } from "./harnesses/skill-listing/discovery.js";

export {
  COLLECTION_CONTROL_DIRECTORY,
  AUTHOR_WORKSPACE_METADATA_FILE,
} from "./artifact/control-files.js";

export { HarnessName } from "./harnesses/contracts.js";

export { errorMessage } from "./shared/failure.js";
export { ReadmeFrontmatterMissing, DescriptorMalformed } from "./artifact/failures.js";
export { DirectSkillDocumentInvalid, NoSkitDescriptorFound } from "./sources/failures.js";
export {
  SkillsDirectoryNotWritable,
  InstalledSkillFileMissing,
} from "./installed-skills/failures.js";
export { InvalidLibraryState } from "./library/failures.js";

export { resolveDeclaredInvocation } from "./invocation/conformance.js";

export { libraryDoctorReport } from "./library/inventory/doctor-report.js";

export { LinkStat } from "./platform/link-stat.js";
export { acquireFileLock } from "./platform/file-lock.js";

export { skitLayer } from "./platform/layer.js";

export { hashParts } from "./artifact/descriptor.js";
export { deterministicTreeHash } from "./artifact/skit.js";
export { resolveSkitSource } from "./sources/resolve.js";

export { scanInventory } from "./library/inventory/refresh.js";
export { collectionVersionPath } from "./library/collection-version.js";
export {
  importCanBeRefetched,
  librarySnapshotDigests,
  sourceImports,
  currentCollectionSkills,
  currentSkillVersion,
  enabledSkillIds,
  currentLibraryManifest,
} from "./library/library-contracts.js";

export {
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  currentLibraryState,
  emptyLibraryState,
  libraryStateRevision,
  libraryManifestFromLocalState,
} from "./library/library-state.js";
export { globalEnabled, enabledAt } from "./library/enabled.js";
export { InstalledSkill } from "./library/device-state.js";
export { setupIntent } from "./library/setup.js";

export { readSnapshotArchive } from "./library/snapshot-archive.js";
export { makeMachineId } from "./library/entity-ids.js";

export * as Library from "./library/library.js";

export { observePathEvidence, recoveryFingerprint } from "./library/folder-evidence.js";

// Recovery vocabulary is public; reading and mutating recovery evidence belongs to Library.

export { SkitConfiguration, skitConfigurationLayer } from "./platform/configuration.js";
