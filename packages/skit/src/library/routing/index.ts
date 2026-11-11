/** Device routing and read-only duplicate facts shared by frontends and Library. */
export { DuplicateScanIncomplete, DuplicateScanIssue } from "../installed-skill-facts.js";
export { skillsDirectoryFor, inventoryRootOptions, type InventoryRootOptions } from "./roots.js";
export {
  DuplicateCopy,
  SkillAlias,
  scanSkillsDirectory,
  readableSkillsDirectories,
  findDuplicates,
  DuplicateScanError,
} from "./duplicates.js";
