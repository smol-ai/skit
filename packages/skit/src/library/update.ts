/** Source update progress and failure contracts; the update itself is `library.update`. */
export type { SourceUpdateAdapters } from "./internal/session/update-sources.js";
export {
  type LibraryProgressStage,
  type LibraryProgressCompletion,
  type LibraryProgressReporter,
} from "./internal/session/source-updates.js";

export { AuthoredSkillIssue } from "./authored-skill-issues.js";
