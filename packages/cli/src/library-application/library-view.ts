import {
  currentCollectionSkills,
  currentSkillVersion,
  enabledSkillIds,
  globalEnabled,
  LibraryStore,
  type Enabled,
  type LibraryState,
  type InstallScope,
} from "@smolai/skit-core";
import { Effect } from "effect";
import {
  enabledCollections,
  sameInstallScope,
  uniqueInstallScopes,
  type EnabledCollection,
} from "../workflows/library/set-enabled-request.js";
import { librarySubjects } from "../workflows/library/subject-resolution.js";
import { readDescriptionLoad } from "../workflows/library/collection-load.js";
import { readLibrarySkillMetadata, sourceIdentityLabel } from "./skill-metadata.js";
import { makeLibrarySkillInvocationReader } from "../invocation/library-source.js";

/** Internal constructor: derive a read model from the same snapshot used by a prepared action. */
export const libraryView = (current: LibraryState, originalsPath: string) => {
  const state = structuredClone(current);
  const placements = structuredClone(enabledCollections(state));
  const skills = state.skills.map((skill) => {
    const collection = state.collections.find((item) => item.collection_id === skill.collection_id);
    const source =
      collection?.upstream?.source_identity ??
      state.imports.find((item) => item.collection_id === skill.collection_id)?.source_identity;
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
  const atScope = (scope: EnabledCollection["scope"] | undefined) =>
    placements.filter(
      (placement) => scope === undefined || sameInstallScope(placement.scope, scope),
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
          scopes: placements
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
    placementsAt: (scope: EnabledCollection["scope"] | undefined) =>
      structuredClone(atScope(scope)),
    scopesFor: (collectionId: string) =>
      structuredClone(
        uniqueInstallScopes(
          placements.filter((item) => item.collectionId === collectionId).map((item) => item.scope),
        ),
      ),
    membersFor: (collectionId: string, scopes?: readonly EnabledCollection["scope"][]) =>
      structuredClone(
        skills.filter(
          (skill) =>
            skill.collectionId === collectionId &&
            (scopes === undefined ||
              placements.some(
                (placement) =>
                  placement.skillIds.includes(skill.id) &&
                  scopes.some((scope) => sameInstallScope(scope, placement.scope)),
              )),
        ),
      ),
    readSkills: Effect.fn("LibraryView.readSkills")(function* () {
      const facts = yield* readFacts();
      const readInvocation = yield* makeLibrarySkillInvocationReader(state, originalsPath);
      return yield* Effect.forEach(
        facts.flatMap((skill) =>
          skill.versionId === undefined ? [] : [{ ...skill, versionId: skill.versionId }],
        ),
        (skill) =>
          Effect.gen(function* () {
            const imported = state.skills.find((imported) => imported.skill_id === skill.id);
            if (imported === undefined)
              return yield* Effect.die(`Missing retained Skill ${skill.id}`);
            const authorInvocation = yield* readInvocation(imported);
            return { ...skill, authorInvocation };
          }),
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
    /** What is enabled for every project on this device, labelled, and the Skills it enables. */
    enabledEverywhere: structuredClone({
      items: globalEnabled(state).enabled.map((item) =>
        "collection" in item
          ? {
              collection: item.collection,
              label:
                state.collections.find((collection) => collection.collection_id === item.collection)
                  ?.label ?? item.collection,
            }
          : {
              skill: item.skill,
              name: state.skills.find((skill) => skill.skill_id === item.skill)?.name ?? item.skill,
            },
      ),
      skills: enabledSkillIds(state, globalEnabled(state).enabled),
    }),
    descriptionLoad: (collectionId: string) => {
      const collection = state.collections.find((item) => item.collection_id === collectionId);
      return readDescriptionLoad(
        state,
        originalsPath,
        collection === undefined ? [] : currentCollectionSkills(state, collection.collection_id),
      );
    },
    listingSizeAfter: (change: {
      readonly scope: InstallScope;
      readonly enabled: readonly Enabled[];
    }) =>
      new Set([
        ...enabledSkillIds(state, change.enabled),
        ...(change.scope.kind === "repository"
          ? enabledSkillIds(state, globalEnabled(state).enabled)
          : []),
      ]).size,
  };
};

/** Open once; all queries describe this Library revision without saving or reconciling. */
export const openLibraryView = Effect.fn("LibraryView.open")(function* () {
  const store = yield* LibraryStore;
  return libraryView(yield* store.load, store.originalsPath);
});
