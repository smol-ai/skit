/** Source updates and their progress and failure contracts. */
export {
  type LibraryProgressStage,
  type LibraryProgressCompletion,
  type LibraryProgressReporter,
} from "./internal/session/source-updates.js";
export { updateSources } from "./internal/session/update-sources.js";
export type { GitInspectionFailed } from "./internal/session/skills-sh-git-evidence.js";
export type { CollectionNotUpdatable } from "./internal/session/source-updates.js";
export type { SkillsShUpdateMember } from "./internal/session/skills-sh-update-check.js";
export { previewLibrarySourceUpdates } from "./internal/session/queries.js";
