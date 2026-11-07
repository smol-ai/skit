/** Device routing and read-only duplicate facts shared by frontends and Library. */
export type { DuplicateScanIncomplete } from "../installed-skill-facts.js";
export { skillsDirectoryFor, inventoryRootOptions, type InventoryRootOptions } from "./roots.js";
export {
  DuplicateCopy,
  SkillAlias,
  scanSkillsDirectory,
  readableSkillsDirectories,
  findDuplicates,
  type DuplicateScanError,
} from "./duplicates.js";
