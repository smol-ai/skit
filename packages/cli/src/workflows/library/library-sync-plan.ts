import { canonicalJson, type LibraryManifest } from "@smolai/skit-core";
import { normalizeLibraryManifest } from "./library-merge.js";

export interface SyncChange {
  readonly kind: "collection" | "skill" | "binding";
  readonly action: "add" | "update" | "remove";
  readonly subject_id?: string;
  readonly label?: string;
  readonly label_before?: string;
  readonly label_after?: string;
  readonly harness?: LibraryManifest["bindings"][number]["harness"];
  readonly skills_before: readonly string[];
  readonly skills_after: readonly string[];
  readonly versions_before: readonly string[];
  readonly versions_after: readonly string[];
  readonly evidence_changed: boolean;
}

export interface SyncPlan {
  readonly local: readonly SyncChange[];
  readonly remote: readonly SyncChange[];
}

const action = (before: unknown, after: unknown): SyncChange["action"] =>
  before === undefined ? "add" : after === undefined ? "remove" : "update";

const collectionName = (manifest: LibraryManifest, collectionId: string): string =>
  manifest.collections.find((collection) => collection.collection_id === collectionId)?.label ??
  collectionId;

const collectionSkills = (manifest: LibraryManifest, collectionId: string): readonly string[] =>
  manifest.skills
    .filter((skill) => skill.collection_id === collectionId)
    .map((skill) => skill.name)
    .sort();

const collectionVersions = (manifest: LibraryManifest, collectionId: string): readonly string[] =>
  manifest.skills
    .filter((skill) => skill.collection_id === collectionId)
    .flatMap((skill) => {
      const version = skill.versions.find(
        (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
      );
      return version === undefined ? [] : [`${skill.name} @ ${version.source_digest}`];
    })
    .sort();

const collectionGraph = (manifest: LibraryManifest, collectionId: string) => {
  const skills = manifest.skills.filter((skill) => skill.collection_id === collectionId);
  const acquisitionIds = new Set(
    skills.flatMap((skill) =>
      skill.versions.flatMap((version) => version.origins.map((origin) => origin.acquisition_id)),
    ),
  );
  const acquisitions = manifest.acquisitions.filter((item) =>
    acquisitionIds.has(item.acquisition_id),
  );
  const retainedCopyIds = new Set(acquisitions.map((item) => item.retained_copy_id));
  return {
    collection: manifest.collections.find((item) => item.collection_id === collectionId),
    skills,
    acquisitions,
    retained_copies: manifest.retained_copies.filter((item) =>
      retainedCopyIds.has(item.retained_copy_id),
    ),
  };
};

const changes = (before: LibraryManifest, after: LibraryManifest): readonly SyncChange[] => {
  const collectionIds = [
    ...new Set([
      ...before.collections.map((item) => item.collection_id),
      ...after.collections.map((item) => item.collection_id),
    ]),
  ].sort();
  const collectionChanges = collectionIds.flatMap((collectionId): SyncChange[] => {
    const previous = before.collections.find((item) => item.collection_id === collectionId);
    const desired = after.collections.find((item) => item.collection_id === collectionId);
    if (
      previous !== undefined &&
      desired !== undefined &&
      canonicalJson(collectionGraph(before, collectionId)) ===
        canonicalJson(collectionGraph(after, collectionId))
    )
      return [];
    const skillsBefore = collectionSkills(before, collectionId);
    const skillsAfter = collectionSkills(after, collectionId);
    const versionsBefore = collectionVersions(before, collectionId);
    const versionsAfter = collectionVersions(after, collectionId);
    return [
      {
        kind: "collection",
        action: action(previous, desired),
        subject_id: collectionId,
        label: desired?.label ?? previous?.label ?? collectionName(after, collectionId),
        ...(previous === undefined ? {} : { label_before: previous.label }),
        ...(desired === undefined ? {} : { label_after: desired.label }),
        skills_before: skillsBefore,
        skills_after: skillsAfter,
        versions_before: versionsBefore,
        versions_after: versionsAfter,
        evidence_changed:
          previous !== undefined &&
          desired !== undefined &&
          previous.label === desired.label &&
          canonicalJson(skillsBefore) === canonicalJson(skillsAfter) &&
          canonicalJson(versionsBefore) === canonicalJson(versionsAfter),
      },
    ];
  });
  const standaloneSkillIds = [
    ...new Set([
      ...before.skills
        .filter((skill) => skill.collection_id === undefined)
        .map((skill) => skill.skill_id),
      ...after.skills
        .filter((skill) => skill.collection_id === undefined)
        .map((skill) => skill.skill_id),
    ]),
  ].sort();
  const standaloneChanges = standaloneSkillIds.flatMap((skillId): SyncChange[] => {
    const previous = before.skills.find((skill) => skill.skill_id === skillId);
    const desired = after.skills.find((skill) => skill.skill_id === skillId);
    const graph = (manifest: LibraryManifest, skill: typeof previous) => {
      if (skill === undefined) return undefined;
      const acquisitionIds = new Set(
        skill.versions.flatMap((version) => version.origins.map((origin) => origin.acquisition_id)),
      );
      const acquisitions = manifest.acquisitions.filter((item) =>
        acquisitionIds.has(item.acquisition_id),
      );
      const retainedCopyIds = new Set(acquisitions.map((item) => item.retained_copy_id));
      return {
        skill,
        acquisitions,
        retained_copies: manifest.retained_copies.filter((item) =>
          retainedCopyIds.has(item.retained_copy_id),
        ),
      };
    };
    if (canonicalJson(graph(before, previous)) === canonicalJson(graph(after, desired))) return [];
    const selectedVersion = (skill: typeof previous) => {
      if (skill === undefined) return [];
      const version = skill.versions.find(
        (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
      );
      return version === undefined ? [] : [`${skill.name} @ ${version.source_digest}`];
    };
    const versionsBefore = selectedVersion(previous);
    const versionsAfter = selectedVersion(desired);
    return [
      {
        kind: "skill",
        action: action(previous, desired),
        subject_id: skillId,
        label: desired?.name ?? previous?.name ?? skillId,
        ...(previous === undefined ? {} : { label_before: previous.name }),
        ...(desired === undefined ? {} : { label_after: desired.name }),
        skills_before: previous === undefined ? [] : [previous.name],
        skills_after: desired === undefined ? [] : [desired.name],
        versions_before: versionsBefore,
        versions_after: versionsAfter,
        evidence_changed:
          previous !== undefined &&
          desired !== undefined &&
          previous.name === desired.name &&
          canonicalJson(versionsBefore) === canonicalJson(versionsAfter),
      },
    ];
  });
  const key = (binding: LibraryManifest["bindings"][number]) => binding.harness;
  const previousBindings = new Map(before.bindings.map((binding) => [key(binding), binding]));
  const desiredBindings = new Map(after.bindings.map((binding) => [key(binding), binding]));
  const bindingChanges = [...new Set([...previousBindings.keys(), ...desiredBindings.keys()])]
    .sort()
    .flatMap((bindingKey): SyncChange[] => {
      const previous = previousBindings.get(bindingKey);
      const desired = desiredBindings.get(bindingKey);
      if (canonicalJson(previous ?? null) === canonicalJson(desired ?? null)) return [];
      const binding = desired ?? previous;
      if (binding === undefined) return [];
      const names = (manifest: LibraryManifest, ids: readonly string[] | undefined) =>
        (ids ?? [])
          .flatMap((id) => {
            const skill = manifest.skills.find((candidate) => candidate.skill_id === id);
            return skill === undefined ? [] : [skill.name];
          })
          .sort();
      return [
        {
          kind: "binding",
          action: action(previous, desired),
          harness: binding.harness,
          skills_before: names(before, previous?.skills),
          skills_after: names(after, desired?.skills),
          versions_before: [],
          versions_after: [],
          evidence_changed: false,
        },
      ];
    });
  return [...collectionChanges, ...standaloneChanges, ...bindingChanges];
};

export const planLibrarySync = (
  local: LibraryManifest,
  remote: LibraryManifest,
  desired: LibraryManifest,
): SyncPlan => {
  const normalizedLocal = normalizeLibraryManifest(local);
  const normalizedRemote = normalizeLibraryManifest(remote);
  const normalizedDesired = normalizeLibraryManifest(desired);
  return {
    local: changes(normalizedLocal, normalizedDesired),
    remote: changes(normalizedRemote, normalizedDesired),
  };
};
