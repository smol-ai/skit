import { Effect } from "effect";
import { pathIsWithin } from "../../platform/path-identity.js";
import {
  effectiveGlobalBindings,
  type LibraryState,
  type InstalledSkill,
} from "../library-state.js";
import { withInstalledSkillMutation } from "../../projection/mutation.js";
import { LibraryStore } from "../store/library-store.js";
import { bindingSkillIds, type Binding } from "../library-contracts.js";
import type { InstallDestination } from "../../vocabulary.js";
import type { SkillId } from "../entity-ids.js";

/** A repository Binding owns its selected installations beneath that repository. */
export const repositorySelectsInstalledSkill = (state: LibraryState, projection: InstalledSkill) =>
  state.local_bindings.some(
    (binding) =>
      pathIsWithin(binding.scope.root, projection.root) &&
      !state.local_bindings.some(
        (other) =>
          other.scope.root !== binding.scope.root &&
          pathIsWithin(binding.scope.root, other.scope.root) &&
          pathIsWithin(other.scope.root, projection.root),
      ) &&
      bindingSkillIds(state, binding).includes(projection.skill_id),
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
    /** The enabled settings to compare against; the state's own when omitted. */
    enabled?: readonly Binding[];
    /** Only copies at inactive or former destinations, leaving enable changes to the caller. */
    inactiveOnly?: boolean;
    onlySkillIds?: readonly SkillId[];
  },
): InstalledSkill[] =>
  state.projections.filter(
    (projection) =>
      (options.onlySkillIds === undefined ||
        (options.onlySkillIds.includes(projection.skill_id) &&
          !repositorySelectsInstalledSkill(state, projection))) &&
      (!(options.activeDestinations as readonly string[]).includes(projection.target) ||
        (!options.inactiveOnly &&
          !(options.enabled ?? effectiveGlobalBindings(state)).some((binding) =>
            bindingSkillIds(state, binding).includes(projection.skill_id),
          ) &&
          !repositorySelectsInstalledSkill(state, projection))),
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
          const projection = mutation.state.projections.find(
            (item) => item.projection_id === copy.projection_id,
          );
          const skill = mutation.state.skills.find((item) => item.skill_id === copy.skill_id);
          if (projection === undefined || skill === undefined) continue;
          const inactive = !(options.activeDestinations as readonly string[]).includes(
            projection.target,
          );
          const outcome = yield* mutation.uninstall(
            projection,
            inactive ? "report" : "throw",
            `Refusing to remove modified ${skill.name} at ${projection.path}`,
          );
          if (outcome.kind === "conflicted") {
            projection.status = "conflicted";
            projection.observed_digest = outcome.observed;
            continue;
          }
          if (outcome.kind === "retired") uninstalled++;
          const index = mutation.state.projections.findIndex(
            (item) => item.projection_id === projection.projection_id,
          );
          if (index >= 0) mutation.state.projections.splice(index, 1);
        }
        return uninstalled;
      }),
  );
  return result.value;
});
