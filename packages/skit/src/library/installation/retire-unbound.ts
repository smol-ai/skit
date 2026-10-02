import { Effect } from "effect";
import { pathIsWithin } from "../../platform/path-identity.js";
import type { LibraryState, ManagedProjection } from "../library-state.js";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { LibraryStore } from "../store/library-store.js";
import { bindingSkillIds, type Binding } from "../library-contracts.js";
import type { ProjectionTarget } from "../store/state-schema.js";

/** A repository Binding owns its selected installations beneath that repository. */
export const repositorySelectsProjection = (state: LibraryState, projection: ManagedProjection) =>
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
 * Retire owned Projections nothing wants any more: their Skill lost its Binding, or their target
 * is inactive on this device or a former per-Harness root. Caller owns the writer lock.
 */
export const retireUnboundGlobalProjectionsEffect = Effect.fn(
  "Library.retireUnboundGlobalProjections",
)(function* (options: {
  variantsPath: string;
  activeTargets: readonly ProjectionTarget[];
  desiredBindings?: readonly Binding[];
  /** Retire only copies at inactive or former targets, leaving Binding changes to the caller. */
  inactiveOnly?: boolean;
}) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const targets = loaded.projections.filter(
    (projection) =>
      !(options.activeTargets as readonly string[]).includes(projection.target) ||
      (!options.inactiveOnly &&
        !(options.desiredBindings ?? loaded.global_bindings).some((binding) =>
          bindingSkillIds(loaded, binding).includes(projection.skill_id),
        ) &&
        !repositorySelectsProjection(loaded, projection)),
  );
  if (targets.length === 0) return 0;
  const result = yield* withProjectionMutationEffect(
    loaded,
    {
      rootFor: () => undefined,
      variantsPath: options.variantsPath,
      publish: store.publish,
    },
    (mutation) =>
      Effect.gen(function* () {
        let retiredCount = 0;
        for (const target of targets) {
          const projection = mutation.state.projections.find(
            (item) => item.projection_id === target.projection_id,
          );
          const skill = mutation.state.skills.find((item) => item.skill_id === target.skill_id);
          if (projection === undefined || skill === undefined) continue;
          // An edited copy at an inactive or former target is kept and reported, not removed.
          // Throwing would block every later reconciliation until someone edits the filesystem.
          const inactive = !(options.activeTargets as readonly string[]).includes(
            projection.target,
          );
          const retired = yield* mutation.retire(
            projection,
            inactive ? "report" : "throw",
            `Refusing to remove modified ${skill.name} at ${projection.path}`,
          );
          if (retired.kind === "conflicted") {
            projection.status = "conflicted";
            projection.observed_digest = retired.observed;
            continue;
          }
          if (retired.kind === "retired") retiredCount++;
          const index = mutation.state.projections.findIndex(
            (item) => item.projection_id === projection.projection_id,
          );
          if (index >= 0) mutation.state.projections.splice(index, 1);
        }
        return retiredCount;
      }),
  );
  return result.value;
});
