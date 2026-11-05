import { dirname, relative, sep } from "node:path";
import type { SetupResult, SetupSkillInstance, SetupInstalledSkill } from "./contract.js";

/** Group observed collections without granting a lock claim or an inferred directory ownership. */
export function setupCollectionGroups(
  data: Pick<SetupResult, "instances" | "installedSkills" | "authoredCollections">,
): SetupResult["collectionGroups"] {
  const sources = new Map<string, SetupSkillInstance[]>();
  const repositories = new Map<
    string,
    { repository: string; root: string; instances: SetupSkillInstance[] }
  >();
  const loose: SetupSkillInstance[] = [];
  for (const instance of data.instances) {
    if (instance.owner.kind === "skit" || instance.owner.kind === "authored") continue;
    const claim = instance.locks[0];
    if (claim) {
      const members = sources.get(claim.entry.source) ?? [];
      members.push(instance);
      sources.set(claim.entry.source, members);
      continue;
    }
    const repository = instance.git.repository;
    const root = dirname(instance.path);
    const segments = repository ? relative(repository, root).split(sep) : [];
    if (
      !repository ||
      segments.at(-1) !== "skills" ||
      segments.length > 2 ||
      segments.includes("..")
    ) {
      loose.push(instance);
      continue;
    }
    const key = JSON.stringify([repository, root]);
    const group = repositories.get(key) ?? { repository, root, instances: [] };
    group.instances.push(instance);
    repositories.set(key, group);
  }
  const inferred = [...repositories.values()].filter((group) => {
    if (new Set(group.instances.map((instance) => instance.name)).size > 1) return true;
    loose.push(...group.instances);
    return false;
  });
  const authoredIds = new Set(
    data.authoredCollections.flatMap((collection) =>
      collection.collectionId ? [collection.collectionId] : [],
    ),
  );
  const installed = new Map<string, SetupInstalledSkill[]>();
  for (const skill of data.installedSkills) {
    if (skill.collectionId && authoredIds.has(skill.collectionId)) continue;
    const key = skill.collectionId ?? skill.skillId;
    const members = installed.get(key) ?? [];
    members.push(skill);
    installed.set(key, members);
  }
  return {
    sources: [...sources]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, instances]) => ({ source, instances })),
    repositories: inferred.sort(
      (left, right) =>
        left.repository.localeCompare(right.repository) || left.root.localeCompare(right.root),
    ),
    loose: loose.sort((left, right) => left.path.localeCompare(right.path)),
    installed: [...installed]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, skills]) => ({ displayName: skills[0]!.collectionDisplayName, skills })),
    authored: data.authoredCollections.map((collection) => ({
      ...collection,
      installedSkills: collection.collectionId
        ? data.installedSkills.filter((skill) => skill.collectionId === collection.collectionId)
        : [],
    })),
  };
}
