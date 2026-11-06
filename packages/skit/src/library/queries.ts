/** Passive Library reports and Skill metadata; storage access stays inside the owner. */
export {
  SkillMetadata,
  readSkillPreviews,
  readLibrarySkillMetadata,
} from "./internal/session/skill-metadata.js";
export type { LibrarySubjectNotFound, LibrarySubjectAmbiguous } from "./subject-resolution.js";
export type { WorkspaceClaim } from "./internal/session/workspace-claims.js";
export {
  readLibraryList,
  readLibraryWorkspaceClaims,
  readInstalledSkills,
  readLibraryManifest,
  readSkillsShCollectionIds,
  readLibraryDescriptionLoad,
  readLibraryHistory,
  checkLibrarySubjects,
} from "./internal/session/queries.js";
