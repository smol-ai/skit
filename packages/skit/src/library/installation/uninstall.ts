import { pathIsWithin } from "../../platform/path-identity.js";
import { globalEnabled, type LibraryState, type InstalledSkill } from "../library-state.js";
import { enabledSkillIds, type Enabled } from "../library-contracts.js";
import type { InstallDestination } from "../../installed-skills/destination.js";
import type { SkillId } from "../entity-ids.js";

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

/**
 * The global copies SKIT installed that no current setting asks for any more: their skill is no
 * longer enabled, or their install destination is inactive on this device or a former per-Harness
 * directory. Changes nothing.
 */
export const leftoverSkills = (
  state: LibraryState,
  options: {
    activeDestinations: readonly InstallDestination[];
    /** What is enabled for every project, to compare against; the state's own when omitted. */
    enabled?: readonly Enabled[];
    /** Only copies at inactive or former destinations, leaving enable changes to the caller. */
    inactiveOnly?: boolean;
    onlySkillIds?: readonly SkillId[];
  },
): InstalledSkill[] =>
  state.installed_skills.filter(
    (installedSkill) =>
      (options.onlySkillIds === undefined ||
        (options.onlySkillIds.includes(installedSkill.skill_id) &&
          !repositorySelectsInstalledSkill(state, installedSkill))) &&
      (!(options.activeDestinations as readonly string[]).includes(installedSkill.destination) ||
        (!options.inactiveOnly &&
          !enabledSkillIds(state, options.enabled ?? globalEnabled(state).enabled).includes(
            installedSkill.skill_id,
          ) &&
          !repositorySelectsInstalledSkill(state, installedSkill))),
  );
