import {
  bindingSkillIds,
  effectiveGlobalBindings,
  currentCollectionSkills,
  currentSkillVersion,
  LibraryStore,
  type LibraryState,
  type SkitBindingScope,
  type DeviceBinding,
  type RepositoryBinding,
} from "@smolai/skit-core";
import { Effect } from "effect";
import {
  bindingPlacements,
  sameBindingScope,
  uniqueBindingScopes,
  type BindingPlacement,
} from "../workflows/library/binding-selection.js";
import { librarySubjects } from "../workflows/library/subject-resolution.js";
import { readDescriptionLoad } from "../workflows/library/collection-load.js";
import { readLibrarySkillMetadata, sourceIdentityLabel } from "./skill-metadata.js";

/** Internal constructor: derive a read model from the same snapshot used by a prepared action. */
export const libraryView = (current: LibraryState, originalsPath: string) => {
  const state = structuredClone(current);
  const placements = structuredClone(bindingPlacements(state));
  const skills = state.skills.map((skill) => {
    const collection = state.collections.find((item) => item.collection_id === skill.collection_id);
    const source =
      collection?.upstream?.source_identity ??
      state.acquisitions.find((item) => item.collection_id === skill.collection_id)
        ?.source_identity;
    return {
      id: skill.skill_id,
      name: skill.name,
      collectionId: skill.collection_id,
      versionId: currentSkillVersion(state, skill)?.skill_version_id,
      versions: skill.versions.map((version) => ({
        id: version.skill_version_id,
        digest: version.artifact_digest,
      })),
      collectionLabel: collection?.label,
      ...(source === undefined
        ? {}
        : { collectionSource: { kind: source.kind, locator: sourceIdentityLabel(source) } }),
    };
  });
  const collections = state.collections.map((collection) => ({
    id: collection.collection_id,
    label: collection.label,
    members: skills.filter((skill) => skill.collectionId === collection.collection_id),
  }));
  const atScope = (scope: BindingPlacement["scope"] | undefined) =>
    placements.filter(
      (placement) => scope === undefined || sameBindingScope(placement.scope, scope),
    );
  const readFacts = Effect.fn("LibraryView.readFacts")(function* () {
    const metadata = yield* readLibrarySkillMetadata(state, originalsPath);
    return yield* Effect.forEach(skills, (skill) => {
      const provenance = metadata.get(skill.id);
      if (provenance === undefined)
        return Effect.die(`Missing metadata for retained Skill ${skill.id}`);
      return Effect.succeed(
        structuredClone({
          ...skill,
          ...provenance,
          bindings: placements
            .filter((placement) => placement.skillIds.includes(skill.id))
            .map((placement) => ({
              scope: placement.scope,
              invocation: placement.invocationBySkill[skill.id] ?? "declared",
            })),
        }),
      );
    });
  });
  return {
    collections: structuredClone(collections),
    placements: structuredClone(placements),
    placementsAt: (scope: BindingPlacement["scope"] | undefined) => structuredClone(atScope(scope)),
    scopesFor: (collectionId: string) =>
      structuredClone(
        uniqueBindingScopes(
          placements.filter((item) => item.collectionId === collectionId).map((item) => item.scope),
        ),
      ),
    membersFor: (collectionId: string, scopes?: readonly BindingPlacement["scope"][]) =>
      structuredClone(
        skills.filter(
          (skill) =>
            skill.collectionId === collectionId &&
            (scopes === undefined ||
              placements.some(
                (placement) =>
                  placement.skillIds.includes(skill.id) &&
                  scopes.some((scope) => sameBindingScope(scope, placement.scope)),
              )),
        ),
      ),
    readSkills: Effect.fn("LibraryView.readSkills")(function* () {
      const facts = yield* readFacts();
      return facts.flatMap((skill) =>
        skill.versionId === undefined ? [] : [{ ...skill, versionId: skill.versionId }],
      );
    }),
    readSubjects: Effect.fn("LibraryView.readSubjects")(function* () {
      const facts = yield* readFacts();
      return librarySubjects(state).map((subject) => ({
        id: subject.subjectId,
        kind: subject.kind,
        label: subject.label,
        skills: facts.filter((skill) =>
          subject.skills.some((member) => member.skill_id === skill.id),
        ),
      }));
    }),
    globalBindings: structuredClone(
      effectiveGlobalBindings(state).map((binding) => ({
        scope: binding.scope,
        entries: binding.entries.map((entry) =>
          entry.kind === "collection"
            ? {
                ...entry,
                label:
                  state.collections.find(
                    (collection) => collection.collection_id === entry.collection_id,
                  )?.label ?? entry.collection_id,
              }
            : {
                ...entry,
                name:
                  state.skills.find((skill) => skill.skill_id === entry.skill_id)?.name ??
                  entry.skill_id,
              },
        ),
        skills: bindingSkillIds(state, binding),
      })),
    ),
    descriptionLoad: (collectionId: string) => {
      const collection = state.collections.find((item) => item.collection_id === collectionId);
      return readDescriptionLoad(
        state,
        originalsPath,
        collection === undefined ? [] : currentCollectionSkills(state, collection.collection_id),
      );
    },
    listingSizeAfter: (change: {
      readonly scope: SkitBindingScope;
      readonly bindings: readonly (DeviceBinding | RepositoryBinding)[];
    }) =>
      new Set(
        [
          ...change.bindings,
          ...(change.scope.kind === "repository" ? effectiveGlobalBindings(state) : []),
        ].flatMap((binding) => bindingSkillIds(state, binding)),
      ).size,
  };
};

/** Open once; all queries describe this Library revision without publishing or reconciling. */
export const openLibraryView = Effect.fn("LibraryView.open")(function* () {
  const store = yield* LibraryStore;
  return libraryView(yield* store.load, store.originalsPath);
});
