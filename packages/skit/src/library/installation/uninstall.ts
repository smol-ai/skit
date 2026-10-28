import { Effect } from "effect";
import { pathIsWithin } from "../../platform/path-identity.js";
import { globalEnabled, type LibraryState, type InstalledSkill } from "../library-state.js";
import { withInstalledSkillMutation } from "../../install/mutation.js";
import { LibraryStore } from "../store/library-store.js";
import { enabledSkillIds, type Enabled } from "../library-contracts.js";
import type { InstallDestination } from "../../vocabulary.js";
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

/**
 * Uninstall these installed skills: each copy SKIT still owns is backed up and its record removed.
 * An edited copy at an active destination is refused; at an inactive or former destination it is
 * kept and reported instead, so it cannot block every later update. Returns how many were
 * uninstalled. Caller owns the writer lock.
 */
export const uninstallSkills = Effect.fn("Library.uninstallSkills")(function* (
  copies: readonly InstalledSkill[],
  options: { variantsPath: string; activeDestinations: readonly InstallDestination[] },
) {
  if (copies.length === 0) return 0;
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const result = yield* withInstalledSkillMutation(
    loaded,
    {
      rootFor: () => undefined,
      variantsPath: options.variantsPath,
      originalsPath: store.originalsPath,
      save: store.save,
    },
    (mutation) =>
      Effect.gen(function* () {
        let uninstalled = 0;
        for (const copy of copies) {
          const installedSkill = mutation.state.installed_skills.find(
            (item) => item.installed_skill_id === copy.installed_skill_id,
          );
          const skill = mutation.state.skills.find((item) => item.skill_id === copy.skill_id);
          if (installedSkill === undefined || skill === undefined) continue;
          const inactive = !(options.activeDestinations as readonly string[]).includes(
            installedSkill.destination,
          );
          const outcome = yield* mutation.uninstall(
            installedSkill,
            inactive ? "report" : "throw",
            `Refusing to remove modified ${skill.name} at ${installedSkill.path}`,
          );
          if (outcome.kind === "conflicted") {
            installedSkill.status = "conflicted";
            installedSkill.current_hash = outcome.observed;
            continue;
          }
          if (outcome.kind === "uninstalled") uninstalled++;
          const index = mutation.state.installed_skills.findIndex(
            (item) => item.installed_skill_id === installedSkill.installed_skill_id,
          );
          if (index >= 0) mutation.state.installed_skills.splice(index, 1);
        }
        return uninstalled;
      }),
  );
  return result.value;
});
