import {
  canonicalJson,
  planThreeWayRecords,
  portableSnapshotDigests,
  PortableLibraryManifest,
  type PortableBinding,
  type PortableCollection,
  type PortableSkill,
  type PortableRetainedCopy,
  type PortableAcquisition,
} from "@smolai/skit-core";
import { Option, Schema } from "effect";

const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const byKey = <T>(records: readonly T[], key: (record: T) => string) =>
  Object.fromEntries(records.map((record) => [key(record), record])) as Record<string, T>;
const bindingKey = (binding: PortableBinding) => `${binding.collection_id}\0${binding.harness}`;

export function normalizePortableManifest(
  manifest: PortableLibraryManifest,
): PortableLibraryManifest {
  return {
    schema: "skit.library.v4",
    collections: [...manifest.collections].sort((a, b) =>
      a.collection_id.localeCompare(b.collection_id),
    ),
    skills: manifest.skills
      .map((skill) => ({
        ...skill,
        versions: skill.versions
          .map((version) => ({
            ...version,
            origins: [...version.origins].sort((a, b) =>
              canonicalJson(a).localeCompare(canonicalJson(b)),
            ),
          }))
          .sort((a, b) => a.skill_version_id.localeCompare(b.skill_version_id)),
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
      .map((binding) => ({ ...binding, skills: [...binding.skills].sort() }))
      .sort((a, b) => bindingKey(a).localeCompare(bindingKey(b))),
  };
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
export function mergePortableManifests(
  base: PortableLibraryManifest,
  local: PortableLibraryManifest,
  remote: PortableLibraryManifest,
  takeRemote: ReadonlySet<string> = new Set(),
) {
  base = normalizePortableManifest(base);
  local = normalizePortableManifest(local);
  remote = normalizePortableManifest(remote);
  const collections = mergeRecords<PortableCollection>(
    "collection",
    base.collections,
    local.collections,
    remote.collections,
    (item) => item.collection_id,
    takeRemote,
  );
  const skills = mergeRecords<PortableSkill>(
    "skill",
    base.skills,
    local.skills,
    remote.skills,
    (item) => item.skill_id,
    takeRemote,
  );
  const trees = mergeRecords<PortableRetainedCopy>(
    "retained-tree",
    base.retained_copies,
    local.retained_copies,
    remote.retained_copies,
    (item) => item.retained_copy_id,
    takeRemote,
  );
  const acquisitions = mergeRecords<PortableAcquisition>(
    "acquisition",
    base.acquisitions,
    local.acquisitions,
    remote.acquisitions,
    (item) => item.acquisition_id,
    takeRemote,
  );
  const bindings = mergeRecords<PortableBinding>(
    "binding",
    base.bindings,
    local.bindings,
    remote.bindings,
    bindingKey,
    takeRemote,
  );
  const manifest = {
    schema: "skit.library.v4" as const,
    collections: collections.values,
    skills: skills.values,
    retained_copies: trees.values,
    acquisitions: acquisitions.values,
    snapshot_digests: portableSnapshotDigests({
      retained_copies: trees.values,
      acquisitions: acquisitions.values,
    }),
    bindings: bindings.values,
  };
  const conflicts = [
    ...collections.conflicts,
    ...skills.conflicts,
    ...trees.conflicts,
    ...acquisitions.conflicts,
    ...bindings.conflicts,
  ];
  if (
    conflicts.length === 0 &&
    Option.isNone(Schema.decodeUnknownOption(PortableLibraryManifest)(manifest))
  )
    conflicts.push("manifest:membership");
  return { manifest, conflicts: [...new Set(conflicts)].sort() };
}
