import { Effect, Schema } from "effect";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import type { SkillId } from "../entity-ids.js";
import { LibraryStore } from "../store/library-store.js";
import type { InvocationPolicy } from "../store/state-schema.js";
import type { BindingEntry } from "../library-contracts.js";

export class CollectionRemovalMissing extends Schema.TaggedError<CollectionRemovalMissing>()(
  "Library.CollectionRemovalMissing",
  { collection_id: Schema.String },
) {}

export class SkillRemovalRequiresCollection extends Schema.TaggedError<SkillRemovalRequiresCollection>()(
  "Library.SkillRemovalRequiresCollection",
  { skill_id: Schema.String, collection_id: Schema.String },
) {}

/** Remove a Collection with its Skills, Acquisitions, Binding entries and Projections. */
export const removeCollectionEffect = Effect.fn("Library.removeCollection")(function* (options: {
  collectionId: string;
  variantsPath: string;
}) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const collection = loaded.collections.find((item) => item.collection_id === options.collectionId);
  if (collection === undefined)
    return yield* new CollectionRemovalMissing({ collection_id: options.collectionId });
  const removedSkillIds = new Set<string>(
    loaded.skills
      .filter((skill) => skill.collection_id === options.collectionId)
      .map((skill) => skill.skill_id),
  );
  const keepEntry = (entry: BindingEntry) =>
    entry.kind === "collection"
      ? entry.collection_id !== options.collectionId
      : !removedSkillIds.has(entry.skill_id);
  const remainingPolicies = (policies?: Readonly<Record<SkillId, InvocationPolicy>>) => {
    const invocation_policies = Object.fromEntries(
      Object.entries(policies ?? {}).filter(([skillId]) => !removedSkillIds.has(skillId)),
    );
    return Object.keys(invocation_policies).length === 0 ? {} : { invocation_policies };
  };
  const result = yield* withProjectionMutationEffect(
    loaded,
    {
      rootFor: () => undefined,
      variantsPath: options.variantsPath,
      publish: (candidate) => {
        const acquisitions = candidate.acquisitions.filter(
          (acquisition) => acquisition.collection_id !== options.collectionId,
        );
        const survivingCopyIds = new Set(
          acquisitions.map((acquisition) => acquisition.retained_copy_id),
        );
        return store.publish({
          ...candidate,
          collections: candidate.collections.filter(
            (item) => item.collection_id !== options.collectionId,
          ),
          global_bindings: candidate.global_bindings
            .map(({ invocation_policies, ...binding }) => ({
              ...binding,
              entries: binding.entries.filter(keepEntry),
              ...remainingPolicies(invocation_policies),
            }))
            .filter((item) => item.entries.length > 0),
          local_bindings: candidate.local_bindings
            .map(({ invocation_policies, ...binding }) => ({
              ...binding,
              entries: binding.entries.filter(keepEntry),
              ...remainingPolicies(invocation_policies),
            }))
            .filter((item) => item.entries.length > 0),
          projections: candidate.projections.filter((item) => !removedSkillIds.has(item.skill_id)),
          skills: candidate.skills.filter((skill) => !removedSkillIds.has(skill.skill_id)),
          acquisitions,
          retained_copies: candidate.retained_copies.filter((copy) =>
            survivingCopyIds.has(copy.retained_copy_id),
          ),
        });
      },
    },
    (mutation) =>
      Effect.gen(function* () {
        let retired = 0;
        for (const projection of mutation.state.projections.filter((item) =>
          removedSkillIds.has(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === projection.skill_id);
          if (skill === undefined) continue;
          const outcome = yield* mutation.retire(
            projection,
            "throw",
            `Refusing to remove modified ${skill.name} at ${projection.path}`,
          );
          if (outcome.kind === "retired") retired++;
        }
        return retired;
      }),
  );
  return { collection_id: options.collectionId, retired: result.value };
});
