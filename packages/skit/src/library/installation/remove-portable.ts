import { Effect, Schema } from "effect";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { LibraryStore } from "../store/library-store.js";

export class PortableCollectionRemovalMissing extends Schema.TaggedError<PortableCollectionRemovalMissing>()(
  "Library.PortableCollectionRemovalMissing",
  { collection_id: Schema.String },
) {}

export const removePortableCollectionEffect = Effect.fn("Library.removePortableCollection")(
  function* (options: { collectionId: string; variantsPath: string }) {
    const store = yield* LibraryStore;
    const loaded = yield* store.load;
    const collection = loaded.collections.find(
      (item) => item.collection_id === options.collectionId,
    );
    if (collection === undefined)
      return yield* new PortableCollectionRemovalMissing({ collection_id: options.collectionId });
    const result = yield* withProjectionMutationEffect(
      loaded,
      {
        rootFor: () => undefined,
        variantsPath: options.variantsPath,
        publish: (candidate) => {
          const removedSkills = candidate.skills.filter(
            (skill) => skill.collection_id === options.collectionId,
          );
          const removedSkillIds = new Set(removedSkills.map((skill) => skill.skill_id));
          const skills = candidate.skills.filter((skill) => !removedSkillIds.has(skill.skill_id));
          const survivingAcquisitionIds = new Set(
            skills.flatMap((skill) =>
              skill.versions.flatMap((version) =>
                version.origins.map((origin) => origin.acquisition_id),
              ),
            ),
          );
          const acquisitions = candidate.acquisitions.filter((acquisition) =>
            survivingAcquisitionIds.has(acquisition.acquisition_id),
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
              .map((item) => ({
                ...item,
                skills: item.skills.filter((skillId) => !removedSkillIds.has(skillId)),
              }))
              .filter((item) => item.skills.length > 0),
            local_bindings: candidate.local_bindings
              .map((item) => ({
                ...item,
                skills: item.skills.filter((skillId) => !removedSkillIds.has(skillId)),
              }))
              .filter((item) => item.skills.length > 0),
            projections: candidate.projections.filter(
              (item) => !removedSkillIds.has(item.skill_id),
            ),
            skills,
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
            mutation.state.skills.some(
              (skill) =>
                skill.skill_id === item.skill_id && skill.collection_id === options.collectionId,
            ),
          )) {
            const skill = mutation.state.skills.find(
              (item) => item.skill_id === projection.skill_id,
            );
            if (skill === undefined) continue;
            const outcome = yield* mutation.retire(
              projection,
              "throw",
              `Refusing to remove modified ${skill.name} on ${projection.harness}`,
            );
            if (outcome.kind === "retired") retired++;
          }
          return retired;
        }),
    );
    return { collection_id: options.collectionId, retired: result.value };
  },
);
