import { canonicalJson, type PortableLibraryManifest } from "@smolai/skit-core";
import { normalizePortableManifest } from "./portable-merge.js";

export interface PortableSyncChange {
  readonly kind: "collection" | "binding";
  readonly action: "add" | "update" | "remove";
  readonly collection_id?: string;
  readonly collection?: string;
  readonly collection_before?: string;
  readonly collection_after?: string;
  readonly harness?: PortableLibraryManifest["bindings"][number]["harness"];
  readonly skills_before: readonly string[];
  readonly skills_after: readonly string[];
  readonly versions_before: readonly string[];
  readonly versions_after: readonly string[];
  readonly evidence_changed: boolean;
}

export interface PortableSyncPlan {
  readonly local: readonly PortableSyncChange[];
  readonly remote: readonly PortableSyncChange[];
}

const action = (before: unknown, after: unknown): PortableSyncChange["action"] =>
  before === undefined ? "add" : after === undefined ? "remove" : "update";

const collectionName = (manifest: PortableLibraryManifest, collectionId: string): string =>
  manifest.collections.find((collection) => collection.collection_id === collectionId)?.label ??
  collectionId;

const collectionSkills = (
  manifest: PortableLibraryManifest,
  collectionId: string,
): readonly string[] =>
  manifest.skills
    .filter((skill) => skill.collection_id === collectionId)
    .map((skill) => skill.name)
    .sort();

const collectionVersions = (
  manifest: PortableLibraryManifest,
  collectionId: string,
): readonly string[] =>
  manifest.skills
    .filter((skill) => skill.collection_id === collectionId)
    .flatMap((skill) => {
      const version = skill.versions.find(
        (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
      );
      return version === undefined ? [] : [`${skill.name} @ ${version.source_digest}`];
    })
    .sort();

const collectionGraph = (manifest: PortableLibraryManifest, collectionId: string) => {
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

const changes = (
  before: PortableLibraryManifest,
  after: PortableLibraryManifest,
): readonly PortableSyncChange[] => {
  const collectionIds = [
    ...new Set([
      ...before.collections.map((item) => item.collection_id),
      ...after.collections.map((item) => item.collection_id),
    ]),
  ].sort();
  const collectionChanges = collectionIds.flatMap((collectionId): PortableSyncChange[] => {
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
        collection_id: collectionId,
        collection: desired?.label ?? previous?.label ?? collectionName(after, collectionId),
        ...(previous === undefined ? {} : { collection_before: previous.label }),
        ...(desired === undefined ? {} : { collection_after: desired.label }),
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
  const key = (binding: PortableLibraryManifest["bindings"][number]) => binding.harness;
  const previousBindings = new Map(before.bindings.map((binding) => [key(binding), binding]));
  const desiredBindings = new Map(after.bindings.map((binding) => [key(binding), binding]));
  const bindingChanges = [...new Set([...previousBindings.keys(), ...desiredBindings.keys()])]
    .sort()
    .flatMap((bindingKey): PortableSyncChange[] => {
      const previous = previousBindings.get(bindingKey);
      const desired = desiredBindings.get(bindingKey);
      if (canonicalJson(previous ?? null) === canonicalJson(desired ?? null)) return [];
      const binding = desired ?? previous;
      if (binding === undefined) return [];
      const names = (manifest: PortableLibraryManifest, ids: readonly string[] | undefined) =>
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
  return [...collectionChanges, ...bindingChanges];
};

export const planPortableLibrarySync = (
  local: PortableLibraryManifest,
  remote: PortableLibraryManifest,
  desired: PortableLibraryManifest,
): PortableSyncPlan => {
  const normalizedLocal = normalizePortableManifest(local);
  const normalizedRemote = normalizePortableManifest(remote);
  const normalizedDesired = normalizePortableManifest(desired);
  return {
    local: changes(normalizedLocal, normalizedDesired),
    remote: changes(normalizedRemote, normalizedDesired),
  };
};
