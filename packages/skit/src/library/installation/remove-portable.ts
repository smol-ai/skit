import { Effect, Schema } from "effect";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { LibraryStore } from "../store/library-store.js";

export class PortableCollectionRemovalMissing extends Schema.TaggedError<PortableCollectionRemovalMissing>()(
  "Library.PortableCollectionRemovalMissing",
  { collection_id: Schema.String },
) {}

export class PortableSkillRemovalMissing extends Schema.TaggedError<PortableSkillRemovalMissing>()(
  "Library.PortableSkillRemovalMissing",
  { skill_id: Schema.String },
) {}

const removePortableSkillsEffect = Effect.fn("Library.removePortableSkills")(function* (options: {
  skillIds: readonly string[];
  collectionId?: string;
  variantsPath: string;
}) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const removedSkillIds = new Set(options.skillIds);
  const missing = options.skillIds.find(
    (skillId) => !loaded.skills.some((skill) => skill.skill_id === skillId),
  );
  if (missing !== undefined) return yield* new PortableSkillRemovalMissing({ skill_id: missing });
  const result = yield* withProjectionMutationEffect(
    loaded,
    {
      rootFor: () => undefined,
      variantsPath: options.variantsPath,
      publish: (candidate) => {
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
        const pruneBinding = <
          T extends {
            readonly skills: readonly string[];
            readonly invocation_policies?: Readonly<Record<string, unknown>>;
          },
        >(
          binding: T,
        ) => {
          const invocation_policies =
            binding.invocation_policies === undefined
              ? undefined
              : Object.fromEntries(
                  Object.entries(binding.invocation_policies).filter(
                    ([skillId]) => !removedSkillIds.has(skillId),
                  ),
                );
          return {
            ...binding,
            skills: binding.skills.filter((skillId) => !removedSkillIds.has(skillId)),
            ...(invocation_policies === undefined || Object.keys(invocation_policies).length === 0
              ? {}
              : { invocation_policies }),
          };
        };
        return store.publish({
          ...candidate,
          collections:
            options.collectionId === undefined
              ? candidate.collections
              : candidate.collections.filter((item) => item.collection_id !== options.collectionId),
          global_bindings: candidate.global_bindings
            .map(pruneBinding)
            .filter((item) => item.skills.length > 0),
          local_bindings: candidate.local_bindings
            .map(pruneBinding)
            .filter((item) => item.skills.length > 0),
          projections: candidate.projections.filter((item) => !removedSkillIds.has(item.skill_id)),
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
          removedSkillIds.has(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === projection.skill_id);
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
  return { retired: result.value };
});

export const removePortableSkillEffect = Effect.fn("Library.removePortableSkill")(
  function* (options: { skillId: string; variantsPath: string }) {
    const result = yield* removePortableSkillsEffect({
      skillIds: [options.skillId],
      variantsPath: options.variantsPath,
    });
    return { skill_id: options.skillId, retired: result.retired };
  },
);

export const removePortableCollectionEffect = Effect.fn("Library.removePortableCollection")(
  function* (options: { collectionId: string; variantsPath: string }) {
    const store = yield* LibraryStore;
    const loaded = yield* store.load;
    const collection = loaded.collections.find(
      (item) => item.collection_id === options.collectionId,
    );
    if (collection === undefined)
      return yield* new PortableCollectionRemovalMissing({ collection_id: options.collectionId });
    const result = yield* removePortableSkillsEffect({
      collectionId: options.collectionId,
      skillIds: loaded.skills
        .filter((skill) => skill.collection_id === options.collectionId)
        .map((skill) => skill.skill_id),
      variantsPath: options.variantsPath,
    });
    return { collection_id: options.collectionId, retired: result.retired };
  },
);
