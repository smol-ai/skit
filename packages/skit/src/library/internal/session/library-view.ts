import { previewSourceUpdates, type SourceInspection } from "./source-updates.js";
import { checkLibrarySubjects } from "./check.js";
import type { Hash } from "../../../shared/hash.js";
import {
  type SkitSource,
  currentCollectionSkills,
  currentSkillVersion,
  enabledSkillIds,
  type Enabled,
} from "../../library-contracts.js";
import { removalSummary } from "./remove.js";
import { securityReview } from "../security/review.js";
import { Library } from "../../library.js";
import { emptyLibraryState, type LibraryState } from "../../library-state.js";
import { join } from "node:path";

import { globalEnabled } from "../../enabled.js";

import { type InstallScope } from "../../scope.js";
import { Effect } from "effect";
import {
  enabledCollections,
  sameInstallScope,
  uniqueInstallScopes,
  type EnabledCollection,
} from "./set-enabled-request.js";
import { librarySubjects } from "../../subject-resolution.js";
import { readDescriptionLoad } from "./description-load.js";
import { readLibrarySkillMetadata, sourceIdentityLabel } from "./skill-metadata.js";
import { makeLibrarySkillInvocationReader } from "./invocation-source.js";

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
        hash: version.artifact_hash,
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
    previewSourceUpdates: <E, R>(
      query: string | undefined,
      inspectSource: (
        input: SkitSource,
        previousSkillPaths?: readonly string[],
      ) => Effect.Effect<SourceInspection, E, R>,
    ) => previewSourceUpdates(state, query, inspectSource),
    checkSubjects: <E, R>(
      query: string | undefined,
      options: {
        readonly inspectSource: (
          source: SkitSource,
        ) => Effect.Effect<{ readonly snapshot_digest: Hash }, E, R>;
        readonly onCollection?: (collection: {
          readonly collection_id: string;
          readonly display_name: string;
        }) => Effect.Effect<void>;
      },
    ) =>
      checkLibrarySubjects(
        state,
        originalsPath,
        query,
        options.inspectSource,
        options.onCollection,
      ),
    removalSummary: (query: string) => removalSummary(state, query),
    securityReview: (query: string) => securityReview(state, originalsPath, query),
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
    descriptionLoad: (
      subject: { readonly collection: string } | { readonly skills: readonly string[] },
    ) => {
      const collection =
        "collection" in subject
          ? state.collections.find((item) => item.collection_id === subject.collection)
          : undefined;
      return readDescriptionLoad(
        state,
        originalsPath,
        "skills" in subject
          ? state.skills.filter((skill) => subject.skills.includes(skill.skill_id))
          : collection === undefined
            ? []
            : currentCollectionSkills(state, collection.collection_id),
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
export const openLibraryView = Effect.fn("LibraryView.open")(function* (home: string) {
  const snapshot = yield* (yield* Library.Service).read;
  return libraryView(
    snapshot._tag === "Present" ? snapshot.state : emptyLibraryState(),
    join(home, "originals"),
  );
});
