import { Data, Effect } from "effect";
import { join } from "node:path";
import { LibraryChanged } from "../../failures.js";
import { withInstalledSkillMutation } from "../../projection/mutation.js";
import { removeFromEnabled } from "../enabled.js";
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
 * Remove a Collection with its Skills, imports, Binding entries and installed skills, exactly as
 * `planned` records them. The caller holds the writer lock; a Library that moved on since it was
 * planned is refused before any installed skill is touched, so nothing outside the plan is removed.
 */
export const removeCollection = Effect.fn("Library.removeCollection")(function* (
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
  const result = yield* withInstalledSkillMutation(
    planned,
    {
      rootFor: () => undefined,
      variantsPath: options.variantsPath,
      originalsPath: store.originalsPath,
      save: store.save,
    },
    (mutation) =>
      Effect.gen(function* () {
        let retired = 0;
        for (const projection of mutation.state.installed_skills.filter((item) =>
          removedSkillIds.has(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === projection.skill_id);
          if (skill === undefined) continue;
          const outcome = yield* mutation.uninstall(
            projection,
            "throw",
            `Refusing to remove modified ${skill.name} at ${projection.path}`,
          );
          if (outcome.kind === "retired") retired++;
        }
        // Only a batch that retired every copy removes the Collection. A failed one saves just
        // the copies it moved aside.
        const candidate = mutation.state;
        const acquisitions = candidate.imports.filter(
          (acquisition) => acquisition.collection_id !== options.collectionId,
        );
        const survivingCopyIds = new Set(
          acquisitions.map((acquisition) => acquisition.collection_version_id),
        );
        const { invocation_policies, ...enabled } = removeFromEnabled(candidate, {
          skills: removedSkillIds,
          collections: new Set([options.collectionId]),
        });
        Object.assign(candidate, {
          ...enabled,
          collections: candidate.collections.filter(
            (item) => item.collection_id !== options.collectionId,
          ),
          installed_skills: candidate.installed_skills.filter(
            (item) => !removedSkillIds.has(item.skill_id),
          ),
          skills: candidate.skills.filter((skill) => !removedSkillIds.has(skill.skill_id)),
          imports: acquisitions,
          collection_versions: candidate.collection_versions.filter((copy) =>
            survivingCopyIds.has(copy.collection_version_id),
          ),
        });
        // Assigning cannot remove a key, so overrides left for no remaining Skill go explicitly.
        if (invocation_policies === undefined)
          delete (candidate as { invocation_policies?: unknown }).invocation_policies;
        else Object.assign(candidate, { invocation_policies });
        return retired;
      }),
  );
  return { collection_id: options.collectionId, retired: result.value };
});
