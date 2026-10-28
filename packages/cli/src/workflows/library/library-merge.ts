import { alignLibrary, aliasManifest, aliasDevice } from "./library-alignment.js";
import {
  importCanBeRefetched,
  sourceImports,
  currentCollectionSkills,
  canonicalJson,
  currentLibraryManifest,
  planThreeWayRecords,
  librarySnapshotDigests,
  LibraryManifest,
  LibraryState,
  emptyLibraryState,
  enabledSkillIds,
  mergeEnabled,
  currentSkillVersion,
  type Enabled,
  type CollectionId,
  type SkillId,
  type Collection,
  type Skill,
  type CollectionVersion,
  type Import,
} from "@smolai/skit-core";
import { Data, Effect, Result, Schema } from "effect";
import { SyncConflictDetail } from "./library-sync-contract.js";

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const byKey = <T>(records: readonly T[], key: (record: T) => string) =>
  Object.fromEntries(records.map((record) => [key(record), record])) as Record<string, T>;
const enabledKind = (item: Enabled) => ("collection" in item ? "collection" : "skill");
const enabledId = (item: Enabled) => ("collection" in item ? item.collection : item.skill);

const collectionRecords = (manifest: LibraryManifest, id: CollectionId) => ({
  collection: manifest.collections.find((item) => item.collection_id === id),
  skills: manifest.skills.filter((item) => item.collection_id === id),
  imports: manifest.imports.filter((item) => item.collection_id === id),
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
    ...manifest.imports.filter((item) => item.collection_id !== id),
    ...remote.imports.filter((item) => item.collection_id === id),
  ];
  const referenced = new Set(acquisitions.map((item) => item.collection_version_id));
  const retained_copies = [
    ...manifest.collection_versions,
    ...remote.collection_versions.filter(
      (item) =>
        referenced.has(item.collection_version_id) &&
        !manifest.collection_versions.some(
          (copy) => copy.collection_version_id === item.collection_version_id,
        ),
    ),
  ];
  const memberIds = new Set(
    [...manifest.skills, ...remote.skills]
      .filter((item) => item.collection_id === id)
      .map((item) => item.skill_id),
  );
  const belongs = (item: Enabled) =>
    "collection" in item ? item.collection === id : memberIds.has(item.skill);
  return {
    ...manifest,
    collections: [
      ...manifest.collections.filter((item) => item.collection_id !== id),
      ...remote.collections.filter((item) => item.collection_id === id),
    ],
    skills,
    imports: acquisitions,
    collection_versions: retained_copies,
    enabled: mergeEnabled({ skills, imports: acquisitions, collection_versions: retained_copies }, [
      [...manifest.enabled.filter((item) => !belongs(item)), ...remote.enabled.filter(belongs)],
    ]),
  };
};

/** One device's global intent: which Collections it follows and which Skills are enabled now. */
const enabledIntent = (manifest: LibraryManifest) => ({
  followed: Object.fromEntries(
    manifest.enabled.flatMap((item) =>
      "collection" in item ? [[item.collection, true] as const] : [],
    ),
  ),
  enabled: Object.fromEntries(
    enabledSkillIds(manifest, manifest.enabled).map((skillId) => [skillId, true] as const),
  ),
});

/**
 * Merge what the account enables per Skill rather than per stored item. Disabling one Skill of a
 * followed Collection rewrites the Collection item as individual Skill items, so merging raw
 * items would let two devices that each disabled a different Skill re-enable both.
 */
function mergeEnabledIntent(
  base: LibraryManifest,
  local: LibraryManifest,
  remote: LibraryManifest,
  library: Parameters<typeof enabledSkillIds>[0] & { readonly collections: readonly Collection[] },
  takeRemote: ReadonlySet<string>,
) {
  const [before, mine, theirs] = [base, local, remote].map(enabledIntent);
  const followed = planThreeWayRecords(before!.followed, mine!.followed, theirs!.followed, equal);
  const enabled = planThreeWayRecords(before!.enabled, mine!.enabled, theirs!.enabled, equal);
  // A removal on either device takes the removed records' items with it, exactly as removing
  // them after the other device's enable change would have.
  const collectionIds = new Set<string>(library.collections.map((item) => item.collection_id));
  const skillIds = new Set<string>(library.skills.map((item) => item.skill_id));
  const present = (item: Enabled) =>
    "collection" in item ? collectionIds.has(item.collection) : skillIds.has(item.skill);
  const items: Enabled[] = [
    ...Object.keys(followed.records).map((collectionId): Enabled => ({
      collection: collectionId as CollectionId,
    })),
    ...Object.keys(enabled.records).map((skillId): Enabled => ({ skill: skillId as SkillId })),
  ].filter(present);
  // A followed Collection enables every current member, so it cannot coexist with one disabled.
  const coherent = enabledSkillIds(
    library,
    items.filter((item) => "collection" in item),
  ).every((skillId) => enabled.records[skillId] !== undefined);
  if (coherent) return { values: mergeEnabled(library, [items]), conflicts: [] };
  // `binding:global` is the key users already pass to --take-remote.
  return takeRemote.has("binding:global")
    ? { values: mergeEnabled(library, [remote.enabled.filter(present)]), conflicts: [] }
    : { values: [...local.enabled], conflicts: ["binding:global"] };
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
    collection_versions: [...manifest.collection_versions].sort((a, b) =>
      a.collection_version_id.localeCompare(b.collection_version_id),
    ),
    imports: [...manifest.imports].sort((a, b) => a.import_id.localeCompare(b.import_id)),
    snapshot_digests: [...manifest.snapshot_digests].sort(),
    enabled: [...manifest.enabled].sort(
      (a, b) =>
        enabledKind(a).localeCompare(enabledKind(b)) || enabledId(a).localeCompare(enabledId(b)),
    ),
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
  // Source selection belongs to the Collection's import history. A remote choice
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
    const latest = sourceImports(remote, id)[0];
    // Selection has an ID tiebreak, but equal observation times do not authorize discarding history.
    // Preserve only strictly older history; any dropped equal-time content must be source-restorable.
    const kept = local.imports.filter(
      (item) =>
        item.collection_id === id && latest !== undefined && item.imported_at < latest.imported_at,
    );
    const dropped = local.imports.filter(
      (item) =>
        item.collection_id === id &&
        !remote.imports.some((other) => other.import_id === item.import_id) &&
        !kept.some((other) => other.import_id === item.import_id),
    );
    const safe =
      !mine.some((skill) => skill.local_version_id !== undefined) &&
      dropped.every(importCanBeRefetched);
    if (!safe) unresolvable.push(key);
    if (takeRemote.has(key) && safe) {
      const choice = {
        ...remote,
        imports: [
          ...remote.imports,
          ...kept.filter(
            (item) => !remote.imports.some((other) => other.import_id === item.import_id),
          ),
        ],
        collection_versions: [
          ...remote.collection_versions,
          ...local.collection_versions.filter(
            (copy) =>
              kept.some((item) => item.collection_version_id === copy.collection_version_id) &&
              !remote.collection_versions.some(
                (other) => other.collection_version_id === copy.collection_version_id,
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
      const theirsVersion = versions.find(
        (item) => item.artifact_digest === version.artifact_digest,
      );
      if (theirsVersion === undefined) versions.push(version);
      else if (!equal(theirsVersion, version)) incompatible = true;
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
  const trees = mergeRecords<CollectionVersion>(
    "retained-tree",
    base.collection_versions,
    local.collection_versions,
    remote.collection_versions,
    (item) => item.collection_version_id,
    takeRemote,
  );
  const acquisitions = mergeRecords<Import>(
    "acquisition",
    base.imports,
    local.imports,
    remote.imports,
    (item) => item.import_id,
    takeRemote,
  );
  // A copy may be shared by Collections. Keep it while any surviving import references it.
  const referencedCopies = new Set(acquisitions.values.map((item) => item.collection_version_id));
  for (const id of referencedCopies) {
    if (trees.values.some((item) => item.collection_version_id === id)) continue;
    const copy =
      remote.collection_versions.find((item) => item.collection_version_id === id) ??
      local.collection_versions.find((item) => item.collection_version_id === id);
    if (copy !== undefined) trees.values.push(copy);
  }
  trees.values = trees.values.filter((item) => referencedCopies.has(item.collection_version_id));
  const library = {
    collections: collections.values,
    skills: skills.values,
    collection_versions: trees.values,
    imports: acquisitions.values,
  };
  const enabled = mergeEnabledIntent(base, local, remote, library, takeRemote);
  const manifest = currentLibraryManifest({
    collections: collections.values,
    skills: skills.values,
    collection_versions: trees.values,
    imports: acquisitions.values,
    snapshot_digests: librarySnapshotDigests({
      collection_versions: trees.values,
      imports: acquisitions.values,
    }),
    enabled: enabled.values,
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
        ![...base.imports, ...local.imports, ...remote.imports].some(
          (item) =>
            key === `acquisition:${item.import_id}` &&
            conflictedCollections.has(item.collection_id),
        ),
    ),
    ...enabled.conflicts,
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

type MergePreparation = Data.TaggedEnum<{
  Ready: {
    readonly manifest: LibraryManifest;
    readonly alignedLocal: LibraryManifest;
    readonly device: LibraryState;
  };
  InvalidResolution: {};
  Conflicted: { readonly conflicts: readonly SyncConflictDetail[] };
}>;
const MergePreparation = Data.taggedEnum<MergePreparation>();

/**
 * Align portable identities and device references together, then validate and apply merge choices.
 * This prepares data only; ancestry gates, filesystem checks and commit order belong to sync.
 */
export const prepareLibraryMerge = Effect.fn("Library.prepareMerge")(function* (input: {
  readonly base: LibraryManifest;
  readonly local: LibraryManifest;
  readonly remote: LibraryManifest;
  readonly device?: LibraryState;
  readonly takeRemote?: readonly string[];
}) {
  const aliases = alignLibrary(input.local, input.remote, input.base);
  const alignedLocal = aliasManifest(input.local, aliases);
  const alignedBase = aliasManifest(input.base, aliases);
  // Rebuild through the schema so a prepared device carries only fields this CLI declares.
  const device =
    input.device === undefined
      ? emptyLibraryState()
      : yield* LibraryState.makeEffect(aliasDevice(input.device, aliases));
  const independentSkills = aliases.skills.map((alias) => alias.to);
  const independentCollections = aliases.collections.map((alias) => alias.to);
  const preliminary = mergeLibraryManifests(
    alignedBase,
    alignedLocal,
    input.remote,
    new Set(),
    independentSkills,
    independentCollections,
  );
  // A requested key must name an actual remotely resolvable conflict, even on push/pull/clean.
  const requested = new Set(input.takeRemote ?? []);
  const available = describeLibraryMergeConflicts(
    preliminary.conflicts,
    preliminary.manifest,
    preliminary.unresolvable,
  );
  if (
    [...requested].some(
      (key) =>
        !available.some((detail) => detail.key === key && detail.resolution === "take-remote"),
    )
  )
    return MergePreparation.InvalidResolution();
  const merged =
    requested.size === 0
      ? preliminary
      : mergeLibraryManifests(
          alignedBase,
          alignedLocal,
          input.remote,
          requested,
          independentSkills,
          independentCollections,
        );
  if (merged.conflicts.length)
    return MergePreparation.Conflicted({
      conflicts: describeLibraryMergeConflicts(
        merged.conflicts,
        merged.manifest,
        merged.unresolvable,
      ),
    });
  return MergePreparation.Ready({ manifest: merged.manifest, alignedLocal, device });
});
