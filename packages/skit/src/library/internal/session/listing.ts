import { currentSkillVersion, enabledSkillIds } from "../../library-contracts.js";
import type { LibraryState } from "../../library-state.js";
import { globalEnabled } from "../../enabled.js";
import { Effect, Struct } from "effect";
import { enabledCollections } from "../../enabled-plan.js";
import { librarySubjects } from "../../subject-resolution.js";
import { makeLibrarySkillMetadataReader } from "./skill-metadata.js";
import { makeLibrarySkillInvocationReader } from "./invocation-source.js";
import { readCollectionSource } from "../../collection-source.js";

/** Catalogue and selection facts, shared by relational reads and explicitly captured reviews. */
export const libraryListing = (
  current: Pick<
    LibraryState,
    | "collections"
    | "skills"
    | "collection_versions"
    | "imports"
    | "enabled"
    | "repositories"
    | "installed_skills"
    | "device_skill_selection"
    | "invocation_policies"
  >,
  originalsPath: string,
) => {
  const state = structuredClone(
    Struct.pick(current, [
      "collections",
      "skills",
      "collection_versions",
      "imports",
      "enabled",
      "repositories",
      "installed_skills",
      "device_skill_selection",
      "invocation_policies",
    ]),
  );
  const placements = structuredClone(enabledCollections(state));
  const skills = state.skills.map((skill) => {
    const collection = state.collections.find((item) => item.collection_id === skill.collection_id);
    return {
      record: skill,
      value: {
        id: skill.skill_id,
        name: skill.name,
        collectionId: skill.collection_id,
        versionId: currentSkillVersion(state, skill)?.skill_version_id,
        versions: skill.versions.map((version) => ({
          id: version.skill_version_id,
          hash: version.artifact_hash,
        })),
        collectionLabel: collection?.label,
      },
    };
  });
  const names = new Map(state.skills.map((skill) => [skill.skill_id, skill.name]));
  const installedSkills = state.installed_skills.flatMap((copy) => {
    const name = names.get(copy.skill_id);
    return name === undefined
      ? []
      : [
          {
            skillId: copy.skill_id,
            name,
            destination: copy.destination,
            path: copy.path,
            status: copy.status,
          },
        ];
  });
  const skillsShCollectionIds = [
    ...new Set(
      state.imports
        .filter((sourceImport) =>
          sourceImport.lock_file_entries.some((entry) => entry.type === "skills.sh-lock"),
        )
        .map((sourceImport) => sourceImport.collection_id),
    ),
  ].sort();
  const collections = state.collections.map((collection) => ({
    id: collection.collection_id,
    label: collection.label,
    members: skills
      .filter(({ value }) => value.collectionId === collection.collection_id)
      .map(({ value }) => value),
  }));
  const readFacts = Effect.fn("LibraryView.readFacts")(function* () {
    const readMetadata = makeLibrarySkillMetadataReader(state, originalsPath);
    const sources = new Map(
      yield* Effect.forEach(state.collections, (collection) =>
        Effect.map(
          readCollectionSource(state, collection),
          (source) => [collection.collection_id, source] as const,
        ),
      ),
    );
    return yield* Effect.forEach(skills, ({ record, value }) =>
      Effect.gen(function* () {
        const provenance = yield* readMetadata(record);
        const collectionSource = sources.get(value.collectionId);
        return {
          record,
          value: structuredClone({
            ...value,
            ...provenance,
            ...(collectionSource?.kind === "authored-workspace"
              ? { source: collectionSource.locator || null }
              : {}),
            ...(collectionSource === undefined ? {} : { collectionSource }),
            scopes: placements
              .filter((placement) => placement.skillIds.includes(value.id))
              .map((placement) => ({
                scope: placement.scope,
                invocation: placement.invocationBySkill[value.id] ?? "declared",
              })),
          }),
        };
      }),
    );
  });
  return {
    collections: structuredClone(collections),
    /** Named installed folders for setup reporting and exact usage attribution. */
    installedSkills,
    /** Collections whose retained imports carry skills.sh lock-file evidence. */
    skillsShCollectionIds,
    placements: structuredClone(placements),
    readSkills: Effect.fn("LibraryView.readSkills")(function* () {
      const rows = yield* readFacts();
      const readInvocation = yield* makeLibrarySkillInvocationReader(state, originalsPath);
      return yield* Effect.forEach(
        rows.flatMap(({ record, value }) =>
          value.versionId === undefined
            ? []
            : [{ record, value: { ...value, versionId: value.versionId } }],
        ),
        ({ record, value }) =>
          Effect.gen(function* () {
            const authorInvocation = yield* readInvocation(record);
            return { ...value, authorInvocation };
          }),
      );
    }, Effect.scoped),
    readSubjects: Effect.fn("LibraryView.readSubjects")(function* () {
      const facts = (yield* readFacts()).map(({ value }) => value);
      return yield* Effect.forEach(librarySubjects(state), (subject) =>
        Effect.gen(function* () {
          const members = facts.filter((skill) =>
            subject.skills.some((member) => member.skill_id === skill.id),
          );
          const collectionSource =
            members[0]?.collectionSource ??
            (subject.kind === "collection"
              ? yield* readCollectionSource(state, subject.collection)
              : undefined);
          return {
            id: subject.subjectId,
            kind: subject.kind,
            label: subject.label,
            ...(collectionSource === undefined ? {} : { collectionSource }),
            skills: members,
            enabledSkills: members
              .filter((skill) => skill.scopes.length > 0)
              .map((skill) => skill.id),
            scopes: [
              ...new Map(
                members
                  .flatMap((skill) => skill.scopes)
                  .map(({ scope }) => [JSON.stringify(scope), scope]),
              ).values(),
            ],
          };
        }),
      );
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
  };
};
