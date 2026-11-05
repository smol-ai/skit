import { pathIsWithin } from "../../platform/path-identity.js";
import { type LibraryState, type InstalledSkill } from "../library-state.js";
import { enabledSkillIds } from "../library-contracts.js";

/** A repository owns the installed skills it enables beneath it. */
export const repositorySelectsInstalledSkill = (
  state: LibraryState,
  installedSkill: InstalledSkill,
) =>
  state.repositories.some(
    (repository) =>
      pathIsWithin(repository.root, installedSkill.root) &&
      !state.repositories.some(
        (other) =>
          other.root !== repository.root &&
          pathIsWithin(repository.root, other.root) &&
          pathIsWithin(other.root, installedSkill.root),
      ) &&
      enabledSkillIds(state, repository.enabled).includes(installedSkill.skill_id),
  );
