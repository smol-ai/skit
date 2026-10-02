import {
  acquisitionIsSourceRestorable,
  sourceAcquisitions,
  currentCollectionSkills,
  canonicalJson,
  currentLibraryManifest,
  planThreeWayRecords,
  librarySnapshotDigests,
  LibraryManifest,
  bindingSkillIds,
  mergeGlobalBindings,
  currentSkillVersion,
  type Binding,
  type BindingEntry,
  type CollectionId,
  type SkillId,
  type Collection,
  type Skill,
  type RetainedCopy,
  type Acquisition,
} from "@smolai/skit-core";
import { Result, Schema } from "effect";
import { SyncConflictDetail } from "./library-sync-contract.js";

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const byKey = <T>(records: readonly T[], key: (record: T) => string) =>
  Object.fromEntries(records.map((record) => [key(record), record])) as Record<string, T>;
const bindingKey = (binding: Binding) => binding.scope.kind;

const collectionRecords = (manifest: LibraryManifest, id: CollectionId) => ({
  collection: manifest.collections.find((item) => item.collection_id === id),
  skills: manifest.skills.filter((item) => item.collection_id === id),
  acquisitions: manifest.acquisitions.filter((item) => item.collection_id === id),
});

/** Apply a Collection-level choice to its dependent records, before the per-record merge. */
const takeCollection = (
  manifest: LibraryManifest,
  remote: LibraryManifest,
  id: CollectionId,
): LibraryManifest => {
  const skills = [
    ...manifest.skills.filter((item) => item.collection_id !== id),
    ...remote.skills.filter((item) => item.collection_id === id),
  ];
  const acquisitions = [
    ...manifest.acquisitions.filter((item) => item.collection_id !== id),
    ...remote.acquisitions.filter((item) => item.collection_id === id),
  ];
  const referenced = new Set(acquisitions.map((item) => item.retained_copy_id));
  const retained_copies = [
    ...manifest.retained_copies,
    ...remote.retained_copies.filter(
      (item) =>
        referenced.has(item.retained_copy_id) &&
        !manifest.retained_copies.some((copy) => copy.retained_copy_id === item.retained_copy_id),
    ),
  ];
  const memberIds = new Set(
    [...manifest.skills, ...remote.skills]
      .filter((item) => item.collection_id === id)
      .map((item) => item.skill_id),
  );
  const belongs = (entry: BindingEntry) =>
    entry.kind === "collection" ? entry.collection_id === id : memberIds.has(entry.skill_id);
  return {
    ...manifest,
    collections: [
      ...manifest.collections.filter((item) => item.collection_id !== id),
      ...remote.collections.filter((item) => item.collection_id === id),
    ],
    skills,
    acquisitions,
    retained_copies,
    bindings: mergeGlobalBindings({ skills, acquisitions, retained_copies }, [
      {
        entries: [
          ...manifest.bindings
            .flatMap((binding) => binding.entries)
            .filter((entry) => !belongs(entry)),
          ...remote.bindings.flatMap((binding) => binding.entries).filter(belongs),
        ],
      },
    ]),
  };
};

/** One device's global intent: which Collections it follows and which Skills are enabled now. */
const bindingIntent = (manifest: LibraryManifest) => {
  const entries = manifest.bindings.flatMap((binding) => binding.entries);
  return {
    followed: Object.fromEntries(
      entries.flatMap((entry) =>
        entry.kind === "collection" ? [[entry.collection_id, true] as const] : [],
      ),
    ),
    enabled: Object.fromEntries(
      bindingSkillIds(manifest, { entries }).map((skillId) => [skillId, true] as const),
    ),
  };
};

/**
 * Merge global Binding intent per Skill rather than per stored entry. Disabling one Skill of a
 * followed Collection rewrites the Collection entry as individual Skill entries, so merging raw
 * entries would let two devices that each disabled a different Skill re-enable both.
 */
function mergeBindingIntent(
  base: LibraryManifest,
  local: LibraryManifest,
  remote: LibraryManifest,
  library: Parameters<typeof bindingSkillIds>[0] & { readonly collections: readonly Collection[] },
  takeRemote: ReadonlySet<string>,
) {
  const [before, mine, theirs] = [base, local, remote].map(bindingIntent);
  const followed = planThreeWayRecords(before!.followed, mine!.followed, theirs!.followed, equal);
  const enabled = planThreeWayRecords(before!.enabled, mine!.enabled, theirs!.enabled, equal);
  // A removal on either device takes the removed records' entries with it, exactly as removing
  // them after the other device's Binding change would have.
  const collectionIds = new Set<string>(library.collections.map((item) => item.collection_id));
  const skillIds = new Set<string>(library.skills.map((item) => item.skill_id));
  const present = (entry: BindingEntry) =>
    entry.kind === "collection"
      ? collectionIds.has(entry.collection_id)
      : skillIds.has(entry.skill_id);
  const entries: BindingEntry[] = [
    ...Object.keys(followed.records).map((collectionId): BindingEntry => ({
      kind: "collection",
      collection_id: collectionId as CollectionId,
    })),
    ...Object.keys(enabled.records).map((skillId): BindingEntry => ({
      kind: "skill",
      skill_id: skillId as SkillId,
    })),
  ].filter(present);
  // A followed Collection enables every current member, so it cannot coexist with one disabled.
  const coherent = bindingSkillIds(library, {
    entries: entries.filter((entry) => entry.kind === "collection"),
  }).every((skillId) => enabled.records[skillId] !== undefined);
  if (coherent) return { values: mergeGlobalBindings(library, [{ entries }]), conflicts: [] };
  return takeRemote.has("binding:global")
    ? {
        values: mergeGlobalBindings(
          library,
          remote.bindings.map((binding) => ({ entries: binding.entries.filter(present) })),
        ),
        conflicts: [],
      }
    : { values: local.bindings, conflicts: ["binding:global"] };
}

export function normalizeLibraryManifest(manifest: LibraryManifest): LibraryManifest {
  return currentLibraryManifest({
    collections: [...manifest.collections].sort((a, b) =>
      a.collection_id.localeCompare(b.collection_id),
    ),
    skills: manifest.skills
      .map((skill) => ({
        ...skill,
        versions: [...skill.versions].sort((a, b) =>
          a.skill_version_id.localeCompare(b.skill_version_id),
        ),
      }))
      .sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
    retained_copies: [...manifest.retained_copies].sort((a, b) =>
      a.retained_copy_id.localeCompare(b.retained_copy_id),
    ),
    acquisitions: [...manifest.acquisitions].sort((a, b) =>
      a.acquisition_id.localeCompare(b.acquisition_id),
    ),
    snapshot_digests: [...manifest.snapshot_digests].sort(),
    bindings: manifest.bindings
      .map((binding) => ({
        ...binding,
        entries: [...binding.entries].sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            (a.kind === "collection" ? a.collection_id : a.skill_id).localeCompare(
              b.kind === "collection" ? b.collection_id : b.skill_id,
            ),
        ),
      }))
      .sort((a, b) => bindingKey(a).localeCompare(bindingKey(b))),
  });
}

function mergeRecords<T>(
  label: string,
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  key: (record: T) => string,
  takeRemote: ReadonlySet<string>,
) {
  const planned = planThreeWayRecords(
    byKey(base, key),
    byKey(local, key),
    byKey(remote, key),
    equal,
  );
  const records = { ...planned.records };
  const conflicts = [];
  for (const conflict of planned.conflicts) {
    const coordinate = `${label}:${conflict}`;
    if (takeRemote.has(coordinate)) {
      const remoteRecord = byKey(remote, key)[conflict];
      if (remoteRecord === undefined) delete records[conflict];
      else records[conflict] = remoteRecord;
    } else conflicts.push(coordinate);
  }
  return { values: Object.values(records).sort((a, b) => key(a).localeCompare(key(b))), conflicts };
}

/** Pure accepted-base merge of portable Library entities and global Binding intent. */
export function mergeLibraryManifests(
  base: LibraryManifest,
  local: LibraryManifest,
  remote: LibraryManifest,
  takeRemote: ReadonlySet<string> = new Set(),
  independentImports: readonly SkillId[] = [],
  independentCollections: readonly CollectionId[] = [],
) {
  base = normalizeLibraryManifest(base);
  local = normalizeLibraryManifest(local);
  remote = normalizeLibraryManifest(remote);
  const collectionConflicts: string[] = [];
  const conflictedCollections = new Set<CollectionId>();
  const unresolvable: string[] = [];
  // Source selection belongs to the Collection's observed Acquisition graph. A remote choice
  // must adopt that graph, rather than pinning a Source Version as a retained local edit.
  const importCollections = new Set([
    ...independentCollections,
    ...local.skills
      .filter((skill) => independentImports.includes(skill.skill_id))
      .map((skill) => skill.collection_id),
  ]);
  for (const id of importCollections) {
    const mine = local.skills.filter((skill) => skill.collection_id === id);
    const theirs = remote.skills.filter((skill) => skill.collection_id === id);
    const membershipDiffers = !equal(
      currentCollectionSkills(local, id)
        .map((skill) => skill.path)
        .sort(),
      currentCollectionSkills(remote, id)
        .map((skill) => skill.path)
        .sort(),
    );
    const selectionDiffers = mine.some((skill) => {
      const other = theirs.find((item) => item.skill_id === skill.skill_id);
      return (
        other !== undefined &&
        other.local_version_id === undefined &&
        currentSkillVersion(local, skill)?.skill_version_id !==
          currentSkillVersion(remote, other)?.skill_version_id
      );
    });
    if (!membershipDiffers && !selectionDiffers) continue;
    const key = `collection:${id}`;
    const latest = sourceAcquisitions(remote, id)[0];
    // Equal timestamps do not establish precedence; preserve only strictly older history.
    const kept = local.acquisitions.filter(
      (item) =>
        item.collection_id === id && latest !== undefined && item.acquired_at < latest.acquired_at,
    );
    const dropped = local.acquisitions.filter(
      (item) =>
        item.collection_id === id &&
        !remote.acquisitions.some((other) => other.acquisition_id === item.acquisition_id) &&
        !kept.some((other) => other.acquisition_id === item.acquisition_id),
    );
    const safe =
      !mine.some((skill) => skill.local_version_id !== undefined) &&
      dropped.every(acquisitionIsSourceRestorable);
    if (!safe) unresolvable.push(key);
    if (takeRemote.has(key) && safe) {
      const choice = {
        ...remote,
        acquisitions: [
          ...remote.acquisitions,
          ...kept.filter(
            (item) =>
              !remote.acquisitions.some((other) => other.acquisition_id === item.acquisition_id),
          ),
        ],
        retained_copies: [
          ...remote.retained_copies,
          ...local.retained_copies.filter(
            (copy) =>
              kept.some((item) => item.retained_copy_id === copy.retained_copy_id) &&
              !remote.retained_copies.some(
                (other) => other.retained_copy_id === copy.retained_copy_id,
              ),
          ),
        ],
      };
      local = normalizeLibraryManifest(takeCollection(local, choice, id));
      base = normalizeLibraryManifest(takeCollection(base, remote, id));
    } else if (!conflictedCollections.has(id)) {
      collectionConflicts.push(key);
      conflictedCollections.add(id);
    }
  }
  for (const collection of base.collections) {
    const id = collection.collection_id;
    const before = collectionRecords(base, id);
    const mine = collectionRecords(local, id);
    const theirs = collectionRecords(remote, id);
    if (mine.collection !== undefined && theirs.collection !== undefined) continue;
    const survivor = mine.collection === undefined ? theirs : mine;
    if (survivor.collection === undefined || equal(before, survivor)) continue;
    const key = `collection:${id}`;
    if (takeRemote.has(key)) {
      local = normalizeLibraryManifest(takeCollection(local, remote, id));
      base = normalizeLibraryManifest(takeCollection(base, remote, id));
    } else {
      collectionConflicts.push(key);
      conflictedCollections.add(id);
    }
  }
  const collections = mergeRecords<Collection>(
    "collection",
    base.collections,
    local.collections,
    remote.collections,
    (item) => item.collection_id,
    takeRemote,
  );
  const skills = mergeRecords<Skill>(
    "skill",
    base.skills,
    local.skills,
    remote.skills,
    (item) => item.skill_id,
    takeRemote,
  );
  for (const id of independentImports) {
    const mine = local.skills.find((item) => item.skill_id === id);
    const theirs = remote.skills.find((item) => item.skill_id === id);
    if (
      mine === undefined ||
      theirs === undefined ||
      base.skills.some((item) => item.skill_id === id)
    )
      continue;
    const key = `skill:${id}`;
    const mineSelected = currentSkillVersion(local, mine)?.skill_version_id;
    const remoteSelected = currentSkillVersion(remote, theirs)?.skill_version_id;
    const versions = [...theirs.versions];
    let incompatible = false;
    for (const version of mine.versions) {
      const published = versions.find((item) => item.artifact_digest === version.artifact_digest);
      if (published === undefined) versions.push(version);
      else if (!equal(published, version)) incompatible = true;
    }
    const differs =
      incompatible ||
      mine.name !== theirs.name ||
      mine.local_version_id !== theirs.local_version_id ||
      mineSelected !== remoteSelected;
    const resolved = takeRemote.has(key);
    skills.conflicts = skills.conflicts.filter((item) => item !== key);
    if (differs && !resolved) skills.conflicts.push(key);
    const chosen = resolved ? theirs : mine;
    skills.values = [
      ...skills.values.filter((item) => item.skill_id !== id),
      {
        ...chosen,
        versions,
      },
    ];
  }
  const trees = mergeRecords<RetainedCopy>(
    "retained-tree",
    base.retained_copies,
    local.retained_copies,
    remote.retained_copies,
    (item) => item.retained_copy_id,
    takeRemote,
  );
  const acquisitions = mergeRecords<Acquisition>(
    "acquisition",
    base.acquisitions,
    local.acquisitions,
    remote.acquisitions,
    (item) => item.acquisition_id,
    takeRemote,
  );
  // A copy may be shared by Collections. Keep it while any surviving Acquisition references it.
  const referencedCopies = new Set(acquisitions.values.map((item) => item.retained_copy_id));
  for (const id of referencedCopies) {
    if (trees.values.some((item) => item.retained_copy_id === id)) continue;
    const copy =
      remote.retained_copies.find((item) => item.retained_copy_id === id) ??
      local.retained_copies.find((item) => item.retained_copy_id === id);
    if (copy !== undefined) trees.values.push(copy);
  }
  trees.values = trees.values.filter((item) => referencedCopies.has(item.retained_copy_id));
  const library = {
    collections: collections.values,
    skills: skills.values,
    retained_copies: trees.values,
    acquisitions: acquisitions.values,
  };
  const bindings = mergeBindingIntent(base, local, remote, library, takeRemote);
  const manifest = currentLibraryManifest({
    collections: collections.values,
    skills: skills.values,
    retained_copies: trees.values,
    acquisitions: acquisitions.values,
    snapshot_digests: librarySnapshotDigests({
      retained_copies: trees.values,
      acquisitions: acquisitions.values,
    }),
    bindings: bindings.values,
  });
  const conflicts = [
    ...collectionConflicts,
    ...collections.conflicts,
    ...skills.conflicts.filter(
      (key) =>
        ![...base.skills, ...local.skills, ...remote.skills].some(
          (item) =>
            key === `skill:${item.skill_id}` && conflictedCollections.has(item.collection_id),
        ),
    ),
    ...trees.conflicts,
    ...acquisitions.conflicts.filter(
      (key) =>
        ![...base.acquisitions, ...local.acquisitions, ...remote.acquisitions].some(
          (item) =>
            key === `acquisition:${item.acquisition_id}` &&
            conflictedCollections.has(item.collection_id),
        ),
    ),
    ...bindings.conflicts,
  ];
  if (
    conflicts.length === 0 &&
    Result.isFailure(Schema.decodeUnknownResult(LibraryManifest)(manifest))
  )
    conflicts.push("manifest:invariants");
  return { manifest, conflicts: [...new Set(conflicts)].sort(), unresolvable };
}

export function describeLibraryMergeConflicts(
  conflicts: readonly string[],
  manifest: LibraryManifest,
  unresolvable: readonly string[] = [],
) {
  const decoded = Schema.decodeUnknownResult(LibraryManifest)(manifest);
  const invalid = Result.isFailure(decoded) ? decoded.failure.message : "Invalid merged Library";
  return conflicts.map((key) => {
    const collection = manifest.collections.find(
      (item) => key === `collection:${item.collection_id}`,
    );
    const skill = manifest.skills.find((item) => key === `skill:${item.skill_id}`);
    return SyncConflictDetail.make({
      key,
      message: unresolvable.includes(key)
        ? `${collection?.label ?? key} has divergent Source observations and local content that cannot be discarded safely. Preserve the local edit or unpinned Acquisition before syncing; this conflict cannot be taken remotely.`
        : key === "manifest:invariants"
          ? `${invalid}. No changes were applied. This diagnostic cannot be taken remotely; reconcile the named records before syncing.`
          : key.startsWith("collection:")
            ? `${collection?.label ?? key} has incompatible Source observations, changed on both devices, or was removed while its content changed. --take-remote ${key} takes the remote Collection choice and its dependent records, including its Acquisition and Version history, and replaces this Collection's follow and enablement choices with remote's.`
            : key.startsWith("skill:")
              ? `${skill?.name ?? key} differs between devices. --take-remote ${key} selects the remote Skill record.`
              : `Both devices changed ${key}. Resolve with --take-remote ${key}.`,
      resolution:
        key === "manifest:invariants" || unresolvable.includes(key) ? "local" : "take-remote",
    });
  });
}
