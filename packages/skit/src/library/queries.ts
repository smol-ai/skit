/** Passive Skill metadata reports; the Library's own reads are methods on its service. */
export {
  SkillMetadata,
  readSkillPreviews,
  readLibrarySkillMetadata,
} from "./internal/session/skill-metadata.js";
export type { LibrarySubjectNotFound, LibrarySubjectAmbiguous } from "./subject-resolution.js";
export type { WorkspaceClaim } from "./internal/session/workspace-claims.js";
export { CollectionSource } from "./collection-source.js";
