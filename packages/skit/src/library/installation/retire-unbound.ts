import { Effect } from "effect";
import { pathIsWithin } from "../../platform/path-identity.js";
import type { LibraryState, ManagedProjection } from "../library-state.js";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { LibraryStore } from "../store/library-store.js";
import { bindingSkillIds, type Binding } from "../library-contracts.js";

/** A repository Binding owns its selected installations beneath that repository. */
export const repositorySelectsProjection = (state: LibraryState, projection: ManagedProjection) =>
  state.local_bindings.some(
    (binding) =>
      binding.harness === projection.harness &&
      pathIsWithin(binding.scope.root, projection.root) &&
      bindingSkillIds(state, binding).includes(projection.skill_id),
  );

/** Retire owned global Projections whose portable Binding has disappeared. Caller owns the writer lock. */
export const retireUnboundGlobalProjectionsEffect = Effect.fn(
  "Library.retireUnboundGlobalProjections",
)(function* (options: { variantsPath: string; desiredBindings?: readonly Binding[] }) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const targets = loaded.projections.filter(
    (projection) =>
      !(options.desiredBindings ?? loaded.global_bindings).some(
        (binding) =>
          binding.harness === projection.harness &&
          bindingSkillIds(loaded, binding).includes(projection.skill_id),
      ) && !repositorySelectsProjection(loaded, projection),
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
          const retired = yield* mutation.retire(
            projection,
            "throw",
            `Refusing to remove modified ${skill.name} on ${projection.harness}`,
          );
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
