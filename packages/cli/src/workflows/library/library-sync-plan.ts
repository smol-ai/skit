import {
  BindingEntry,
  canonicalJson,
  currentSkillVersion,
  type LibraryManifest,
} from "@smolai/skit-core";
import { Schema } from "effect";
import { normalizeLibraryManifest } from "./library-merge.js";

export type SyncChange =
  | {
      readonly kind: "collection";
      readonly action: "add" | "update" | "remove";
      readonly subject_id: string;
      readonly label: string;
      readonly label_before?: string;
      readonly label_after?: string;
      readonly skills_added: readonly string[];
      readonly skills_removed: readonly string[];
      readonly skills_changed: readonly string[];
      readonly evidence_only: boolean;
    }
  | {
      readonly kind: "binding";
      readonly action: "add" | "update" | "remove";
      readonly entries_added: readonly SyncBindingEntry[];
      readonly entries_removed: readonly SyncBindingEntry[];
    };

export interface SyncBindingEntry {
  readonly kind: "collection" | "skill";
  readonly label: string;
}

export interface SyncPlan {
  readonly local: readonly SyncChange[];
  readonly remote: readonly SyncChange[];
}

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
  const acquisitions = manifest.acquisitions.filter((item) => item.collection_id === collectionId);
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

/** The entries of `from` that `to` lacks, labelled with Collection or Skill names. */
const entriesMissing = (
  manifest: LibraryManifest,
  from: LibraryManifest["bindings"][number] | undefined,
  to: LibraryManifest["bindings"][number] | undefined,
): readonly SyncBindingEntry[] =>
  (from?.entries ?? [])
    .filter(
      (entry) =>
        !(to?.entries ?? []).some((other) => Schema.toEquivalence(BindingEntry)(entry, other)),
    )
    .map((entry) =>
      entry.kind === "collection"
        ? {
            kind: "collection" as const,
            label:
              manifest.collections.find((item) => item.collection_id === entry.collection_id)
                ?.label ?? entry.collection_id,
          }
        : {
            kind: "skill" as const,
            label:
              manifest.skills.find((skill) => skill.skill_id === entry.skill_id)?.name ??
              entry.skill_id,
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
  const previousBindings = new Map(before.bindings.map((binding) => [binding.scope.kind, binding]));
  const desiredBindings = new Map(after.bindings.map((binding) => [binding.scope.kind, binding]));
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
