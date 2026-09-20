import { Effect, Schema } from "effect";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import type { SkillId } from "../entity-ids.js";
import { LibraryStore } from "../store/library-store.js";
import type { InvocationPolicy } from "../store/state-schema.js";
import type { AcquisitionSelection } from "../library-contracts.js";

export class CollectionRemovalMissing extends Schema.TaggedError<CollectionRemovalMissing>()(
  "Library.CollectionRemovalMissing",
  { collection_id: Schema.String },
) {}

export class SkillRemovalMissing extends Schema.TaggedError<SkillRemovalMissing>()(
  "Library.SkillRemovalMissing",
  { skill_id: Schema.String },
) {}

export class SkillRemovalRequiresCollection extends Schema.TaggedError<SkillRemovalRequiresCollection>()(
  "Library.SkillRemovalRequiresCollection",
  { skill_id: Schema.String, collection_id: Schema.String },
) {}

const removeSkillsEffect = Effect.fn("Library.removeSkills")(function* (options: {
  skillIds: readonly string[];
  collectionId?: string;
  revisedSelection?: { collectionId: string; selection: AcquisitionSelection };
  variantsPath: string;
}) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const removedSkillIds = new Set(options.skillIds);
  const missing = options.skillIds.find(
    (skillId) => !loaded.skills.some((skill) => skill.skill_id === skillId),
  );
  if (missing !== undefined) return yield* new SkillRemovalMissing({ skill_id: missing });
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
            readonly skills: readonly SkillId[];
            readonly invocation_policies?: Readonly<Record<SkillId, InvocationPolicy>>;
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
        const collections =
          options.collectionId === undefined
            ? candidate.collections.map((collection) => {
                if (
                  options.revisedSelection === undefined ||
                  collection.collection_id !== options.revisedSelection.collectionId ||
                  collection.upstream === undefined
                )
                  return collection;
                const collectionAcquisitionIds = new Set(
                  skills
                    .filter((skill) => skill.collection_id === collection.collection_id)
                    .flatMap((skill) =>
                      skill.versions.flatMap((version) =>
                        version.origins.map((origin) => origin.acquisition_id),
                      ),
                    ),
                );
                const last = acquisitions
                  .filter((acquisition) => collectionAcquisitionIds.has(acquisition.acquisition_id))
                  .toSorted((left, right) => right.acquired_at.localeCompare(left.acquired_at))[0];
                return {
                  ...collection,
                  upstream: {
                    ...collection.upstream,
                    selection: options.revisedSelection.selection,
                    ...(last === undefined ? {} : { last_acquisition_id: last.acquisition_id }),
                  },
                };
              })
            : candidate.collections.filter((item) => item.collection_id !== options.collectionId);
        return store.publish({
          ...candidate,
          collections,
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

export const removeSkillEffect = Effect.fn("Library.removeSkill")(function* (options: {
  skillId: string;
  variantsPath: string;
}) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const skill = loaded.skills.find((candidate) => candidate.skill_id === options.skillId);
  if (skill === undefined) return yield* new SkillRemovalMissing({ skill_id: options.skillId });
  const collection = loaded.collections.find(
    (candidate) => candidate.collection_id === skill.collection_id,
  );
  const selection = collection?.upstream?.selection;
  if (collection === undefined || selection === undefined || selection.kind === "full-tree")
    return yield* new SkillRemovalRequiresCollection({
      skill_id: skill.skill_id,
      collection_id: skill.collection_id,
    });
  const remaining = loaded.skills.filter(
    (candidate) =>
      candidate.collection_id === collection.collection_id && candidate.skill_id !== skill.skill_id,
  );
  if (remaining.length === 0) {
    const result = yield* removeSkillsEffect({
      collectionId: collection.collection_id,
      skillIds: [options.skillId],
      variantsPath: options.variantsPath,
    });
    return { skill_id: options.skillId, retired: result.retired };
  }
  const revisedSelection: AcquisitionSelection =
    selection.kind === "selected-skills"
      ? { kind: "selected-skills", names: selection.names.filter((name) => name !== skill.name) }
      : { kind: "selected-paths", paths: selection.paths.filter((path) => path !== skill.path) };
  const result = yield* removeSkillsEffect({
    skillIds: [options.skillId],
    revisedSelection: { collectionId: collection.collection_id, selection: revisedSelection },
    variantsPath: options.variantsPath,
  });
  return { skill_id: options.skillId, retired: result.retired };
});

export const removeCollectionEffect = Effect.fn("Library.removeCollection")(function* (options: {
  collectionId: string;
  variantsPath: string;
}) {
  const store = yield* LibraryStore;
  const loaded = yield* store.load;
  const collection = loaded.collections.find((item) => item.collection_id === options.collectionId);
  if (collection === undefined)
    return yield* new CollectionRemovalMissing({ collection_id: options.collectionId });
  const result = yield* removeSkillsEffect({
    collectionId: options.collectionId,
    skillIds: loaded.skills
      .filter((skill) => skill.collection_id === options.collectionId)
      .map((skill) => skill.skill_id),
    variantsPath: options.variantsPath,
  });
  return { collection_id: options.collectionId, retired: result.retired };
});
