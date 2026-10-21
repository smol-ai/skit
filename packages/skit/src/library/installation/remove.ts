import { Data, Effect } from "effect";
import { join } from "node:path";
import { LibraryChanged } from "../../failures.js";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { removeBindingEntities } from "../binding-intent.js";
import { libraryStateRevision, type LibraryState } from "../library-state.js";
import { LibraryStore } from "../store/library-store.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class CollectionRemovalMissing
  extends Data.TaggedError("Library.CollectionRemovalMissing")<{
    collection_id: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit list` to see the retained Collections.";
  get message(): string {
    return `Collection is no longer retained: ${this.collection_id}`;
  }
}

export class SkillRemovalRequiresCollection
  extends Data.TaggedError("Library.SkillRemovalRequiresCollection")<{
    skill_id: string;
    collection_id: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return `Remove the whole Collection with \`skit remove ${this.collection_id}\`, or disable just this Skill.`;
  }
  get message(): string {
    return `${this.skill_id} can be removed only with its Collection ${this.collection_id}`;
  }
}

/**
 * Remove a Collection with its Skills, Acquisitions, Binding entries and Projections, exactly as
 * `planned` records them. The caller holds the writer lock; a Library that moved on since it was
 * planned is refused before any Projection is touched, so nothing outside the plan is removed.
 */
export const removeCollectionEffect = Effect.fn("Library.removeCollection")(function* (
  planned: LibraryState,
  options: { collectionId: string; variantsPath: string },
) {
  const store = yield* LibraryStore;
  if (libraryStateRevision(yield* store.load) !== libraryStateRevision(planned))
    return yield* new LibraryChanged({ path: join(store.home, "state.json") });
  const collection = planned.collections.find(
    (item) => item.collection_id === options.collectionId,
  );
  if (collection === undefined)
    return yield* new CollectionRemovalMissing({ collection_id: options.collectionId });
  const removedSkillIds = new Set<string>(
    planned.skills
      .filter((skill) => skill.collection_id === options.collectionId)
      .map((skill) => skill.skill_id),
  );
  const result = yield* withProjectionMutationEffect(
    planned,
    {
      rootFor: () => undefined,
      variantsPath: options.variantsPath,
      originalsPath: store.originalsPath,
      publish: store.publish,
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
        // Only a batch that retired every copy removes the Collection. A failed one publishes just
        // the copies it moved aside.
        const candidate = mutation.state;
        const acquisitions = candidate.acquisitions.filter(
          (acquisition) => acquisition.collection_id !== options.collectionId,
        );
        const survivingCopyIds = new Set(
          acquisitions.map((acquisition) => acquisition.retained_copy_id),
        );
        Object.assign(candidate, {
          ...removeBindingEntities(candidate, {
            skills: removedSkillIds,
            collections: new Set([options.collectionId]),
          }),
          collections: candidate.collections.filter(
            (item) => item.collection_id !== options.collectionId,
          ),
          projections: candidate.projections.filter((item) => !removedSkillIds.has(item.skill_id)),
          skills: candidate.skills.filter((skill) => !removedSkillIds.has(skill.skill_id)),
          acquisitions,
          retained_copies: candidate.retained_copies.filter((copy) =>
            survivingCopyIds.has(copy.retained_copy_id),
          ),
        });
        return retired;
      }),
  );
  return { collection_id: options.collectionId, retired: result.value };
});
