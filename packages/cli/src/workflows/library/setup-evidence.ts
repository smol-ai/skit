import {
  currentSkillVersion,
  type LibraryState,
  type SkillId,
  type SkillVersionId,
  type MachineId,
} from "@smolai/skit-core";
import { setupLockGroupKey, resolveSkillsShSelectedSource } from "./skills-sh-lock-source.js";
import type { SetupAuthoredCollection, SetupSkillInstance } from "./setup-contract.js";
export const indexSetupLibrary = (
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

export interface SetupRetainedEvidence {
  readonly library?: LibraryState;
  readonly machineId?: MachineId;
}

const lockEvidenceKey = (path: string, hash: string, name: string, skillPath?: string) =>
  [path, hash, name, skillPath ?? ""].join("\0");

/** Immutable joins over one observation. Array and Map insertion order preserve classifier policy. */
export const indexSetupOnboardingEvidence = (
  instances: readonly SetupSkillInstance[],
  retained?: SetupRetainedEvidence,
) => {
  const library = retained?.library;
  const libraryCollectionsById = new Map(
    (library?.collections ?? []).map(
      (collection) => [collection.collection_id, collection] as const,
    ),
  );
  // Preserve the first skill matching either a skill ID or collection ID, as the old find did.
  const librarySkillsBySubject = new Map<string, LibraryState["skills"][number]>();
  for (const skill of library?.skills ?? [])
    for (const id of [skill.skill_id, skill.collection_id])
      if (!librarySkillsBySubject.has(id)) librarySkillsBySubject.set(id, skill);
  const retainedByLockEvidence = new Map<
    string,
    Array<{ subjectId: string; validationIdentityDigest: string }>
  >();
  if (library && retained?.machineId) {
    const evidenceKeysByAcquisition = new Map<string, string[]>();
    const acquisitionsByCollection = new Map<string, LibraryState["acquisitions"][number][]>();
    for (const acquisition of library.acquisitions) {
      const keys = acquisition.observations
        .filter((observation) => observation.machine_id === retained.machineId)
        .map((observation) =>
          lockEvidenceKey(
            observation.lock_path.value,
            observation.lock_content_hash,
            observation.skill_name,
            observation.skill_path,
          ),
        );
      if (keys.length) evidenceKeysByAcquisition.set(acquisition.acquisition_id, keys);
      const group = acquisitionsByCollection.get(acquisition.collection_id) ?? [];
      group.push(acquisition);
      acquisitionsByCollection.set(acquisition.collection_id, group);
    }
    const membersByCopy = new Map<string, Set<string>>();
    for (const copy of library.retained_copies) {
      const members = membersByCopy.get(copy.retained_copy_id) ?? new Set<string>();
      for (const member of copy.members)
        members.add(JSON.stringify([member.source_path, member.artifact_digest]));
      membersByCopy.set(copy.retained_copy_id, members);
    }
    for (const skill of library.skills)
      for (const version of skill.versions)
        for (const acquisition of acquisitionsByCollection.get(skill.collection_id) ?? []) {
          const path = acquisition.kind === "source" ? skill.path : ".";
          if (
            !membersByCopy
              .get(acquisition.retained_copy_id)
              ?.has(JSON.stringify([path, version.artifact_digest]))
          )
            continue;
          for (const key of evidenceKeysByAcquisition.get(acquisition.acquisition_id) ?? []) {
            const evidence = retainedByLockEvidence.get(key) ?? [];
            evidence.push({
              subjectId: skill.collection_id ?? skill.skill_id,
              validationIdentityDigest: version.validation_identity_digest,
            });
            retainedByLockEvidence.set(key, evidence);
          }
        }
  }
  const instancesByLockGroup = new Map<string, SetupSkillInstance[]>();
  for (const instance of instances) {
    const keys = new Set(
      instance.locks.flatMap((lock) => {
        const key = setupLockGroupKey(lock);
        return key === undefined ? [] : [key];
      }),
    );
    for (const key of keys) {
      const group = instancesByLockGroup.get(key) ?? [];
      group.push(instance);
      instancesByLockGroup.set(key, group);
    }
  }
  const lockClaims = new Map(
    [...instancesByLockGroup].map(
      ([key, group]) =>
        [
          key,
          resolveSkillsShSelectedSource(
            group.flatMap((instance) =>
              instance.locks
                .filter((lock) => setupLockGroupKey(lock) === key)
                .map((lock) => ({ lock, name: instance.name })),
            ),
          ),
        ] as const,
    ),
  );
  return { libraryCollectionsById, librarySkillsBySubject, retainedByLockEvidence, lockClaims };
};

export type SetupOnboardingEvidence = ReturnType<typeof indexSetupOnboardingEvidence>;
