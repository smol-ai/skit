import { resolve } from "node:path";
import { Effect, FileSystem, Result } from "effect";
import {
  currentSkillVersion,
  type LibraryState,
  type SkillId,
  type SkillVersionId,
  deterministicTreeHash,
  pathIsWithin,
  installDestinationHarnesses,
} from "@smolai/skit-core";
import { sourceIdentityLabel } from "../../library-application/skill-metadata.js";
import { ownershipAt, type SetupEvidence } from "./setup-discovery.js";
import { lockMatches } from "./skills-sh-lock-source.js";
import { classifyOwner } from "./setup-onboarding.js";
import { makePnpmSkillCheck, pnpmSkillOwner } from "../../install/pnpm-skills.js";
import { probeHarnesses } from "../../harness/probe.js";
import type {
  SetupAuthoredCollection,
  SetupInstalledSkill,
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

const scanSetupInstances = Effect.fn("Setup.scanInstances")(function* (
  evidence: SetupEvidence,
  indexes: ReturnType<typeof indexSetupLibrary>,
  home: string,
) {
  const { hits, harnessRoots, observedLibrary, library, locks } = evidence;
  const { libraryCollectionsById, librarySkillsByHash, authoredBySkillPath } = indexes;
  const observePnpm = yield* makePnpmSkillCheck();
  const grouped = new Map<string, SetupEvidence["hits"]>();
  const pnpmByPath = new Map<string, Effect.Success<ReturnType<typeof pnpmSkillOwner>>>();
  for (const hit of hits) {
    if (!pnpmByPath.has(hit.path)) pnpmByPath.set(hit.path, yield* observePnpm(hit.path));
    const key = `${hit.realPath}\0${pnpmByPath.get(hit.path) ? "pnpm" : "source"}`;
    grouped.set(key, [...(grouped.get(key) ?? []), hit]);
  }
  const instances: SetupSkillInstance[] = [];
  const onboardingInstances: SetupSkillInstance[] = [];
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
    const hashResult = yield* Effect.result(deterministicTreeHash(hit.realPath));
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
            currentHash: hashResult.success,
            libraryMatches,
          };
        })();
    const observedOwnership = yield* ownershipAt(hit.realPath);
    const markerInstalledSkill = observedOwnership.marker
      ? observedLibrary.installed_skills.find(
          (installedSkill) =>
            installedSkill.installed_skill_id === observedOwnership.marker?.installed_skill_id,
        )
      : undefined;
    const ownershipCheck =
      markerInstalledSkill !== undefined &&
      !sorted.some((candidate) => resolve(candidate.path) === resolve(markerInstalledSkill.path))
        ? ({ ownership: "invalid-marker" } as const)
        : observedOwnership;
    const managedMembership = (() => {
      const marker = "marker" in ownershipCheck ? ownershipCheck.marker : undefined;
      if (!marker) return undefined;
      const skill = library.skills.find((candidate) => candidate.skill_id === marker.skill_id);
      const collection =
        skill === undefined ? undefined : libraryCollectionsById.get(skill.collection_id);
      if (skill === undefined)
        return {
          kind: "missing-from-library" as const,
          installedSkillId: marker.installed_skill_id,
          skillId: marker.skill_id,
          skillVersionId: marker.skill_version_id,
        };
      return {
        kind: "in-library" as const,
        installedSkillId: marker.installed_skill_id,
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
    const observedOwner = classifyOwner({
      canonicalPath: hit.realPath,
      home,
      harnesses,
      repository: repositoryHit.git.repository,
      locks: instanceLocks,
    });
    const pnpmOwner = pnpmByPath.get(hit.path);
    const canonicalOwner = yield* observePnpm(hit.realPath);
    const instancePath = Boolean(pnpmOwner) !== Boolean(canonicalOwner) ? hit.path : hit.realPath;
    const owner: SetupSkillInstance["owner"] =
      pnpmOwner ??
      (ownershipCheck.ownership === "skit-managed" && managedMembership
        ? { kind: "skit", membership: managedMembership }
        : ownershipCheck.ownership === "invalid-marker"
          ? { kind: "invalid-marker" }
          : authoredCollection
            ? { kind: "authored", ...authoredCollection }
            : observedOwner);
    const instance: SetupSkillInstance = {
      name: hit.name,
      path: instancePath,
      aliases: [...new Set(sorted.map((candidate) => candidate.path))],
      scope,
      harnesses,
      owner,
      contentIdentity,
      git: repositoryHit.git,
      locks: instanceLocks,
    };
    instances.push(instance);
    // An unrecorded alias keeps its own owner label, but its installed pnpm bytes still
    // cannot be acquired. Do not offer a setup action that acquisition will refuse.
    if (!canonicalOwner && !pnpmOwner) onboardingInstances.push(instance);
  }
  return { instances, onboardingInstances };
});

const scanSetupInstalledSkills = Effect.fn("Setup.scanInstalledSkills")(function* (
  observedLibrary: SetupEvidence["observedLibrary"],
  indexes: ReturnType<typeof indexSetupLibrary>,
) {
  const { libraryCollectionsById } = indexes;
  const installedSkills: SetupInstalledSkill[] = [];
  const fs = yield* FileSystem.FileSystem;
  for (const installedSkill of observedLibrary.installed_skills) {
    const skill = observedLibrary.skills.find(
      (candidate) => candidate.skill_id === installedSkill.skill_id,
    );
    if (skill === undefined) continue;
    const path = installedSkill.path;
    const present = yield* fs.exists(path);
    installedSkills.push({
      collectionId: skill.collection_id,
      collectionDisplayName: libraryCollectionsById.get(skill.collection_id)?.label ?? skill.name,
      skillId: skill.skill_id,
      name: skill.name,
      path,
      harnesses:
        installedSkill.destination === "legacy"
          ? []
          : [...installDestinationHarnesses[installedSkill.destination]],
      status: !present ? "missing" : installedSkill.status === "installed" ? "current" : "modified",
    });
  }
  return installedSkills;
});

export const scanSetupCopies = Effect.fn("Setup.scanCopies")(function* (
  evidence: SetupEvidence,
  home: string,
  probePath?: string,
) {
  const indexes = indexSetupLibrary(evidence.library, evidence.authoredCollections);
  const { instances, onboardingInstances } = yield* scanSetupInstances(evidence, indexes, home);
  const probes = (yield* probeHarnesses(undefined, { path: probePath })).map((probe) => ({
    harness: probe.harnessId,
    status: probe.status,
    command: probe.command,
  }));
  const installedSkills = yield* scanSetupInstalledSkills(evidence.observedLibrary, indexes);
  return { instances, onboardingInstances, probes, installedSkills };
});
