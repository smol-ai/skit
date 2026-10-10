import { resolve } from "node:path";
import { Effect, FileSystem, Result } from "effect";
import {
  currentSkillVersion,
  type LibraryState,
  type SkillId,
  type SkillVersionId,
  deterministicTreeHashEffect,
  pathIsWithin,
  projectionTargetHarnesses,
} from "@smolai/skit-core";
import { sourceIdentityLabel } from "./skill-metadata.js";
import { custodyAt, lockMatches, type SetupEvidence } from "./setup-discovery.js";
import { classifyObservedOwner } from "./setup-onboarding.js";
import { pnpmSkillOwner } from "../../projection/pnpm-skills.js";
import { probeHarnessesEffect } from "../../harness/probe.js";
import type {
  SetupAuthoredCollection,
  SetupProjection,
  SetupSkillInstance,
} from "./setup-contract.js";
const indexSetupLibrary = (
  library: LibraryState,
  authoredCollections: readonly SetupAuthoredCollection[],
) => {
  const authoredBySkillPath = new Map(
    authoredCollections.flatMap((collection) =>
      collection.skills.map(
        (skill) =>
          [
            skill.path,
            {
              skitLocator: collection.skitLocator,
              ...(collection.collectionId ? { collectionId: collection.collectionId } : {}),
            },
          ] as const,
      ),
    ),
  );
  const libraryCollectionsById = new Map(
    library.collections.map((collection) => [collection.collection_id, collection] as const),
  );
  const librarySkillsByHash = new Map<
    string,
    Array<{
      subjectId: string;
      skillId: SkillId;
      skillVersionId: SkillVersionId;
      name: string;
    }>
  >();
  for (const skill of library.skills) {
    const selected = currentSkillVersion(library, skill);
    if (selected === undefined) continue;
    librarySkillsByHash.set(selected.validation_identity_digest, [
      ...(librarySkillsByHash.get(selected.validation_identity_digest) ?? []),
      {
        subjectId: skill.collection_id ?? skill.skill_id,
        skillId: skill.skill_id,
        skillVersionId: selected.skill_version_id,
        name: skill.name,
      },
    ]);
  }
  return { libraryCollectionsById, librarySkillsByHash, authoredBySkillPath };
};

const observeSetupInstances = Effect.fn("Setup.observeInstances")(function* (
  evidence: SetupEvidence,
  indexes: ReturnType<typeof indexSetupLibrary>,
  home: string,
) {
  const { hits, harnessRoots, observedLibrary, library, locks } = evidence;
  const { libraryCollectionsById, librarySkillsByHash, authoredBySkillPath } = indexes;
  const grouped = new Map<string, SetupEvidence["hits"]>();
  for (const hit of hits) grouped.set(hit.realPath, [...(grouped.get(hit.realPath) ?? []), hit]);
  const instances: SetupSkillInstance[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group].sort((left, right) => left.path.localeCompare(right.path));
    const hit = sorted[0];
    if (hit === undefined) continue;
    const roots = harnessRoots.filter(({ root }) =>
      sorted.some((candidate) => pathIsWithin(root, candidate.path)),
    );
    const harnesses = [...new Set(roots.map((root) => root.harness))].sort();
    const scope = roots.some((root) => root.scope === "global")
      ? ("global" as const)
      : hit.repository
        ? ("project" as const)
        : ("standalone" as const);
    const repositoryHit =
      sorted.find((candidate) => candidate.repository && candidate.git.status !== "unavailable") ??
      sorted.find((candidate) => candidate.repository) ??
      hit;
    const authoredCollection = authoredBySkillPath.get(hit.realPath);
    const hashResult = yield* Effect.result(deterministicTreeHashEffect(hit.realPath));
    const contentIdentity = Result.isFailure(hashResult)
      ? { status: "unhashable" as const, libraryMatches: [] }
      : (() => {
          const libraryMatches = librarySkillsByHash.get(hashResult.success) ?? [];
          return {
            status:
              libraryMatches.length === 0
                ? ("none" as const)
                : libraryMatches.length === 1
                  ? ("exact" as const)
                  : ("ambiguous" as const),
            observedHash: hashResult.success,
            libraryMatches,
          };
        })();
    const observedCustody = yield* custodyAt(hit.realPath);
    const markerProjection = observedCustody.marker
      ? observedLibrary.projections.find(
          (projection) => projection.projection_id === observedCustody.marker?.projection_id,
        )
      : undefined;
    const custodyObservation =
      markerProjection !== undefined &&
      !sorted.some((candidate) => resolve(candidate.path) === resolve(markerProjection.path))
        ? ({ custody: "invalid-marker" } as const)
        : observedCustody;
    const managedMembership = (() => {
      const marker = "marker" in custodyObservation ? custodyObservation.marker : undefined;
      if (!marker) return undefined;
      const skill = library.skills.find((candidate) => candidate.skill_id === marker.skill_id);
      const collection =
        skill === undefined ? undefined : libraryCollectionsById.get(skill.collection_id);
      if (skill === undefined)
        return {
          kind: "missing-from-library" as const,
          projectionId: marker.projection_id,
          skillId: marker.skill_id,
          skillVersionId: marker.skill_version_id,
        };
      return {
        kind: "retained" as const,
        projectionId: marker.projection_id,
        collectionId: skill.collection_id,
        skillId: marker.skill_id,
        skillVersionId: marker.skill_version_id,
        displayName: collection?.label ?? skill.name,
        ...(collection?.upstream
          ? {
              source: sourceIdentityLabel(collection.upstream.source_identity),
            }
          : {}),
      };
    })();
    const instanceLocks = yield* lockMatches(
      repositoryHit,
      locks,
      roots.some((root) => root.scope === "global"),
    );
    const observedOwner = classifyObservedOwner({
      canonicalPath: hit.realPath,
      home,
      harnesses,
      repository: repositoryHit.git.repository,
      locks: instanceLocks,
    });
    const pnpmOwners = yield* Effect.forEach(sorted, (candidate) => pnpmSkillOwner(candidate.path));
    const pnpmOwner = pnpmOwners.find((owner) => owner !== undefined);
    const owner: SetupSkillInstance["owner"] =
      pnpmOwner ??
      (custodyObservation.custody === "skit-managed" && managedMembership
        ? { kind: "skit", membership: managedMembership }
        : custodyObservation.custody === "invalid-marker"
          ? { kind: "invalid-marker" }
          : authoredCollection
            ? { kind: "authored", ...authoredCollection }
            : observedOwner);
    instances.push({
      name: hit.name,
      path: hit.realPath,
      aliases: [...new Set(sorted.map((candidate) => candidate.path))],
      scope,
      harnesses,
      owner,
      contentIdentity,
      git: repositoryHit.git,
      locks: instanceLocks,
    });
  }
  return instances;
});

const observeSetupProjections = Effect.fn("Setup.observeProjections")(function* (
  observedLibrary: SetupEvidence["observedLibrary"],
  indexes: ReturnType<typeof indexSetupLibrary>,
) {
  const { libraryCollectionsById } = indexes;
  const projections: SetupProjection[] = [];
  const fs = yield* FileSystem.FileSystem;
  for (const projection of observedLibrary.projections) {
    const skill = observedLibrary.skills.find(
      (candidate) => candidate.skill_id === projection.skill_id,
    );
    if (skill === undefined) continue;
    const path = projection.path;
    const present = yield* fs.exists(path);
    projections.push({
      collectionId: skill.collection_id,
      collectionDisplayName: libraryCollectionsById.get(skill.collection_id)?.label ?? skill.name,
      skillId: skill.skill_id,
      name: skill.name,
      path,
      harnesses:
        projection.target === "legacy" ? [] : [...projectionTargetHarnesses[projection.target]],
      status: !present ? "missing" : projection.status === "installed" ? "current" : "modified",
    });
  }
  return projections;
});

export const observeSetupCopies = Effect.fn("Setup.observeCopies")(function* (
  evidence: SetupEvidence,
  home: string,
  probePath?: string,
) {
  const indexes = indexSetupLibrary(evidence.library, evidence.authoredCollections);
  const instances = yield* observeSetupInstances(evidence, indexes, home);
  const probes = (yield* probeHarnessesEffect(undefined, { path: probePath })).map((probe) => ({
    harness: probe.harnessId,
    status: probe.status,
    command: probe.command,
  }));
  const projections = yield* observeSetupProjections(evidence.observedLibrary, indexes);
  return { instances, probes, projections };
});
