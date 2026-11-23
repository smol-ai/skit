import {
  Enabled,
  currentSkillVersion,
  sourceImports,
  type Collection,
  type LibraryManifest,
} from "../../library-contracts.js";
import { canonicalJson } from "../../../shared/json.js";
import { Schema } from "effect";
import { normalizeLibraryManifest } from "../../manifest.js";

import type { SyncChange, SyncEnabledItem, SyncChanges } from "../../sync-changes.js";
const action = (before: unknown, after: unknown): SyncChange["action"] =>
  before === undefined ? "add" : after === undefined ? "remove" : "update";

/** Each Skill of a Collection by name, with the source digest of its current Version. */
const collectionSkills = (manifest: LibraryManifest, collectionId: string) =>
  new Map(
    manifest.skills
      .filter((skill) => skill.collection_id === collectionId)
      .map((skill) => [skill.name, currentSkillVersion(manifest, skill)?.source_hash]),
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

const collectionSource = (
  manifest: LibraryManifest,
  collection: Collection,
  workspace?: { readonly label: string; readonly authority?: string },
) => {
  const acquisition = sourceImports(manifest, collection.collection_id)[0];
  const source = collection.upstream?.source_identity ?? acquisition?.source_identity;
  if (source === undefined) return {};
  if (source.kind === "registry") {
    const revision =
      acquisition?.source_identity.kind === "registry" ? acquisition.revision : undefined;
    return {
      source_kind: source.kind,
      authority: source.authority,
      ...(revision === undefined || revision === "latest" ? {} : { release_version: revision }),
    };
  }
  return {
    source_kind: source.kind,
    ...(source.kind === "authored-workspace" && workspace?.authority !== undefined
      ? { authority: workspace.authority }
      : {}),
  };
};

/** The items of `from` that `to` lacks, labelled with Collection or Skill names. */
const entriesMissing = (
  manifest: LibraryManifest,
  from: readonly Enabled[] | undefined,
  to: readonly Enabled[] | undefined,
  workspaces: ReadonlyMap<string, { readonly label: string; readonly authority?: string }>,
): readonly SyncEnabledItem[] =>
  (from ?? [])
    .filter((item) => !(to ?? []).some((other) => Schema.toEquivalence(Enabled)(item, other)))
    .map((item) => {
      const skill =
        "skill" in item
          ? manifest.skills.find((candidate) => candidate.skill_id === item.skill)
          : undefined;
      const collectionId = "collection" in item ? item.collection : skill?.collection_id;
      const collection = manifest.collections.find(
        (candidate) => candidate.collection_id === collectionId,
      );
      const workspace = collectionId === undefined ? undefined : workspaces.get(collectionId);
      const label = workspace?.label ?? collection?.label;
      const source =
        collection === undefined ? {} : collectionSource(manifest, collection, workspace);
      return "collection" in item
        ? { kind: "collection", label: label ?? item.collection, ...source }
        : {
            kind: "skill",
            label: skill?.name ?? item.skill,
            ...(label === undefined ? {} : { collection_label: label }),
            ...source,
          };
    });

const changes = (
  before: LibraryManifest,
  after: LibraryManifest,
  workspaces: ReadonlyMap<string, { readonly label: string; readonly authority?: string }>,
): readonly SyncChange[] => {
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
      .filter(([name, hash]) => skillsBefore.has(name) && skillsBefore.get(name) !== hash)
      .map(([name]) => name)
      .sort();
    const workspace = workspaces.get(collectionId);
    const label = workspace?.label;
    const source =
      desired !== undefined
        ? collectionSource(after, desired, workspace)
        : previous === undefined
          ? {}
          : collectionSource(before, previous, workspace);
    return [
      {
        kind: "collection",
        action: action(previous, desired),
        subject_id: collectionId,
        ...source,
        label: label ?? desired?.label ?? previous?.label ?? collectionId,
        ...(previous === undefined ? {} : { label_before: label ?? previous.label }),
        ...(desired === undefined ? {} : { label_after: label ?? desired.label }),
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
  const previousEnabled = new Map(listed(before));
  const desiredEnabled = new Map(listed(after));
  const enabledChanges = [...new Set([...previousEnabled.keys(), ...desiredEnabled.keys()])]
    .sort()
    .flatMap((scope): SyncChange[] => {
      const previous = previousEnabled.get(scope);
      const desired = desiredEnabled.get(scope);
      if (canonicalJson(previous ?? null) === canonicalJson(desired ?? null)) return [];
      return [
        {
          kind: "enabled",
          action: action(previous, desired),
          items_added: entriesMissing(after, desired, previous, workspaces),
          items_removed: entriesMissing(before, previous, desired, workspaces),
        },
      ];
    });
  return [...collectionChanges, ...enabledChanges];
};

export const planLibrarySync = (
  local: LibraryManifest,
  remote: LibraryManifest,
  desired: LibraryManifest,
  workspaces: ReadonlyMap<
    string,
    { readonly label: string; readonly authority?: string }
  > = new Map(),
): SyncChanges => {
  const normalizedLocal = normalizeLibraryManifest(local);
  const normalizedRemote = normalizeLibraryManifest(remote);
  const normalizedDesired = normalizeLibraryManifest(desired);
  return {
    local: changes(normalizedLocal, normalizedDesired, workspaces),
    remote: changes(normalizedRemote, normalizedDesired, workspaces),
  };
};
