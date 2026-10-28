import {
  Enabled,
  canonicalJson,
  currentSkillVersion,
  type LibraryManifest,
} from "@smolai/skit-core";
import { Schema } from "effect";
import { normalizeLibraryManifest } from "./library-merge.js";

import type { SyncChange, SyncBindingEntry, SyncPlan } from "./library-sync-contract.js";
const action = (before: unknown, after: unknown): SyncChange["action"] =>
  before === undefined ? "add" : after === undefined ? "remove" : "update";

/** Each Skill of a Collection by name, with the source digest of its current Version. */
const collectionSkills = (manifest: LibraryManifest, collectionId: string) =>
  new Map(
    manifest.skills
      .filter((skill) => skill.collection_id === collectionId)
      .map((skill) => [skill.name, currentSkillVersion(manifest, skill)?.source_digest]),
  );

const collectionGraph = (manifest: LibraryManifest, collectionId: string) => {
  const skills = manifest.skills.filter((skill) => skill.collection_id === collectionId);
  const imports = manifest.imports.filter((item) => item.collection_id === collectionId);
  const versionIds = new Set(imports.map((item) => item.collection_version_id));
  return {
    collection: manifest.collections.find((item) => item.collection_id === collectionId),
    skills,
    imports,
    collection_versions: manifest.collection_versions.filter((item) =>
      versionIds.has(item.collection_version_id),
    ),
  };
};

/** The items of `from` that `to` lacks, labelled with Collection or Skill names. */
const entriesMissing = (
  manifest: LibraryManifest,
  from: readonly Enabled[] | undefined,
  to: readonly Enabled[] | undefined,
): readonly SyncBindingEntry[] =>
  (from ?? [])
    .filter((item) => !(to ?? []).some((other) => Schema.toEquivalence(Enabled)(item, other)))
    .map((item) =>
      "collection" in item
        ? {
            kind: "collection" as const,
            label:
              manifest.collections.find(
                (collection) => collection.collection_id === item.collection,
              )?.label ?? item.collection,
          }
        : {
            kind: "skill" as const,
            label:
              manifest.skills.find((skill) => skill.skill_id === item.skill)?.name ?? item.skill,
          },
    );

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
    const skills_added = [...skillsAfter.keys()].filter((name) => !skillsBefore.has(name)).sort();
    const skills_removed = [...skillsBefore.keys()].filter((name) => !skillsAfter.has(name)).sort();
    const skills_changed = [...skillsAfter.entries()]
      .filter(([name, digest]) => skillsBefore.has(name) && skillsBefore.get(name) !== digest)
      .map(([name]) => name)
      .sort();
    return [
      {
        kind: "collection",
        action: action(previous, desired),
        subject_id: collectionId,
        label: desired?.label ?? previous?.label ?? collectionId,
        ...(previous === undefined ? {} : { label_before: previous.label }),
        ...(desired === undefined ? {} : { label_after: desired.label }),
        skills_added,
        skills_removed,
        skills_changed,
        evidence_only:
          previous !== undefined &&
          desired !== undefined &&
          previous.label === desired.label &&
          skills_added.length + skills_removed.length + skills_changed.length === 0,
      },
    ];
  });
  // `skit sync` reports the global list as a Binding, present while it enables something.
  const listed = (manifest: LibraryManifest) =>
    manifest.enabled.length > 0 ? [["global", manifest.enabled] as const] : [];
  const previousBindings = new Map(listed(before));
  const desiredBindings = new Map(listed(after));
  const bindingChanges = [...new Set([...previousBindings.keys(), ...desiredBindings.keys()])]
    .sort()
    .flatMap((scope): SyncChange[] => {
      const previous = previousBindings.get(scope);
      const desired = desiredBindings.get(scope);
      if (canonicalJson(previous ?? null) === canonicalJson(desired ?? null)) return [];
      return [
        {
          kind: "binding",
          action: action(previous, desired),
          entries_added: entriesMissing(after, desired, previous),
          entries_removed: entriesMissing(before, previous, desired),
        },
      ];
    });
  return [...collectionChanges, ...bindingChanges];
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
