/** Device routing and read-only duplicate facts shared by frontends and Library. */
export {
  existingRepositorySkillsDirectory,
  skillsDirectoryFor,
  installDestinationsFor,
  selectInventoryRoots,
  type InventoryRootOptions,
} from "./roots.js";
export {
  DuplicateCopy,
  SkillAlias,
  scanSkillsDirectory,
  readableSkillsDirectories,
  findDuplicates,
  type DuplicateScanError,
} from "./duplicates.js";
