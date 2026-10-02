import {
  canonicalJson,
  currentLibraryManifest,
  planThreeWayRecords,
  librarySnapshotDigests,
  LibraryManifest,
  bindingSkillIds,
  mergeGlobalBindings,
  type Binding,
  type BindingEntry,
  type CollectionId,
  type SkillId,
  type Collection,
  type Skill,
  type RetainedCopy,
  type Acquisition,
} from "@smolai/skit-core";
import { Option, Schema } from "effect";

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const byKey = <T>(records: readonly T[], key: (record: T) => string) =>
  Object.fromEntries(records.map((record) => [key(record), record])) as Record<string, T>;
const bindingKey = (binding: Binding) => binding.scope.kind;

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
) {
  base = normalizeLibraryManifest(base);
  local = normalizeLibraryManifest(local);
  remote = normalizeLibraryManifest(remote);
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
    ...collections.conflicts,
    ...skills.conflicts,
    ...trees.conflicts,
    ...acquisitions.conflicts,
    ...bindings.conflicts,
  ];
  if (
    conflicts.length === 0 &&
    Option.isNone(Schema.decodeUnknownOption(LibraryManifest)(manifest))
  )
    conflicts.push("manifest:invariants");
  return { manifest, conflicts: [...new Set(conflicts)].sort() };
}
