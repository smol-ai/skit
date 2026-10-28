import { Schema } from "effect";
import { canonicalJson } from "../shared/json.js";
import {
  ImportId,
  CollectionId,
  MachineId,
  CollectionVersionId,
  SkillId,
  SkillVersionId,
} from "./entity-ids.js";
import { Digest } from "../vocabulary.js";

export const SourceRelativePath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      !value.startsWith("/") &&
      !/^[a-z]:\//i.test(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    { message: "Expected a safe relative path" },
  ),
);
export type SourceRelativePath = typeof SourceRelativePath.Type;
export const CollectionRelativePath = Schema.Union([Schema.Literal("."), SourceRelativePath]);
export type CollectionRelativePath = typeof CollectionRelativePath.Type;

export const HistoricalLocator = Schema.Struct({ value: Schema.String });
export interface HistoricalLocator extends Schema.Schema.Type<typeof HistoricalLocator> {}

const BoundedOriginalEntry = Schema.JsonObject.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(canonicalJson(value)).byteLength <= 65_536,
    { message: "Expected skills.sh original entry no larger than 64 KiB" },
  ),
);

export const SourceIdentity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("github"),
    owner: Schema.NonEmptyString,
    repository: Schema.NonEmptyString,
    collection_root: CollectionRelativePath,
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    remote: HistoricalLocator,
    collection_root: CollectionRelativePath,
  }),
  Schema.Struct({
    kind: Schema.Literal("registry"),
    authority: Schema.NonEmptyString,
    namespace: Schema.NonEmptyString,
    slug: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("url"), url: HistoricalLocator }),
  Schema.Struct({ kind: Schema.Literal("archive"), url: HistoricalLocator }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    machine_id: MachineId,
    path: HistoricalLocator,
  }),
  Schema.Struct({
    kind: Schema.Literal("authored-workspace"),
    workspace_id: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("well-known"),
    locator: HistoricalLocator,
  }),
]);
export type SourceIdentity = typeof SourceIdentity.Type;

const GitSourceFields = {
  ref: Schema.optionalKey(Schema.NonEmptyString),
  subpath: Schema.optionalKey(SourceRelativePath),
  /** Skill directories relative to `subpath`; absent means every Skill found. */
  skillDirectories: Schema.optionalKey(Schema.Array(SourceRelativePath)),
};

/** Where to acquire Skills from. Parsed once from user input; never re-encoded into a string. */
export const SkitSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("github"),
    owner: Schema.NonEmptyString,
    repository: Schema.NonEmptyString,
    ...GitSourceFields,
  }),
  Schema.Struct({ type: Schema.Literal("git"), remote: Schema.NonEmptyString, ...GitSourceFields }),
  Schema.Struct({
    type: Schema.Literal("registry"),
    namespace: Schema.NonEmptyString,
    slug: Schema.NonEmptyString,
    version: Schema.optionalKey(Schema.NonEmptyString),
    authority: Schema.optionalKey(Schema.NonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("well-known"),
    origin: Schema.NonEmptyString,
    skillNames: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  }),
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("archive"), url: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("local"), path: Schema.NonEmptyString }),
]);
export type SkitSource = typeof SkitSource.Type;

/** Exactly what an acquisition fetched, where its Source protocol names it. */
export type SourceRevision =
  | { readonly kind: "commit"; readonly commit: string }
  | { readonly kind: "release"; readonly version: string };

export const SourceTracking = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("default") }),
  Schema.Struct({ kind: Schema.Literal("branch"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("tag"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("commit"), ref: Schema.NonEmptyString }),
]);
export type SourceTracking = typeof SourceTracking.Type;

/** Refresh intent for a Collection: where it comes from and what to follow. */
export const Upstream = Schema.Struct({
  source_identity: SourceIdentity,
  tracking: SourceTracking,
});
export type Upstream = typeof Upstream.Type;

export const SkillsShLockFileEntry = Schema.Struct({
  type: Schema.Literal("skills.sh-lock"),
  machine_id: MachineId,
  observed_at: Schema.String,
  source_updated_at: Schema.optionalKey(Schema.String),
  lock_path: HistoricalLocator,
  lock_version: Schema.Number,
  lock_scope: Schema.Literals(["project", "global"]),
  lock_content_hash: Digest,
  source: Schema.String,
  source_type: Schema.String,
  source_url: Schema.optionalKey(Schema.String),
  source_base_url: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  skill_name: Schema.String,
  skill_path: Schema.optionalKey(SourceRelativePath),
  computed_hash: Schema.optionalKey(Schema.String),
  skill_folder_hash: Schema.optionalKey(Schema.String),
  well_known_digest: Schema.optionalKey(Schema.String),
  content_agreement: Schema.Literals(["agrees", "mismatch", "unverifiable"]),
  original_entry_digest: Digest,
  original_entry: BoundedOriginalEntry,
  upstream_baseline: Schema.optionalKey(
    Schema.Struct({
      source_revision: Schema.String,
      skill_path: SourceRelativePath,
      tree_oid: Schema.String,
      lock_hash_kind: Schema.Literals(["computedHash", "skillFolderHash"]),
      lock_hash: Schema.String,
      verification: Schema.Literals(["lock-only", "lock+retained-bytes"]),
      established_at: Schema.String,
      search_scope: Schema.Literal("ref-path-history"),
    }),
  ),
});
export interface SkillsShLockFileEntry extends Schema.Schema.Type<typeof SkillsShLockFileEntry> {}

export const MaterializationProfile = Schema.Literals(["plain-skill/v1", "declared-skit-skill/v1"]);
export type MaterializationProfile = typeof MaterializationProfile.Type;

export const SkillVersion = Schema.Struct({
  skill_version_id: SkillVersionId,
  source_digest: Digest,
  artifact_digest: Digest,
  validation_identity_digest: Digest,
  materialization_profile: MaterializationProfile,
});
export interface SkillVersion extends Schema.Schema.Type<typeof SkillVersion> {}

export const Skill = Schema.Struct({
  skill_id: SkillId,
  collection_id: CollectionId,
  path: CollectionRelativePath,
  name: Schema.NonEmptyString,
  /** A local edit the user retained; it is used until the Source changes this Skill. */
  local_version_id: Schema.mutableKey(Schema.optional(SkillVersionId)),
  versions: Schema.mutable(Schema.Array(SkillVersion)),
});
export interface Skill extends Schema.Schema.Type<typeof Skill> {}

export const Collection = Schema.Struct({
  collection_id: CollectionId,
  label: Schema.NonEmptyString,
  upstream: Schema.optionalKey(Upstream),
});
export interface Collection extends Schema.Schema.Type<typeof Collection> {}

export const CollectionVersionSkill = Schema.Struct({
  source_path: CollectionRelativePath,
  source_digest: Digest,
  artifact_digest: Digest,
  materialization_profile: MaterializationProfile,
});
export type CollectionVersionSkill = typeof CollectionVersionSkill.Type;

export const CollectionVersion = Schema.Struct({
  collection_version_id: CollectionVersionId,
  digest: Digest,
  copy_profile: Schema.Literal("verbatim/v1"),
  members: Schema.Array(CollectionVersionSkill),
});
export interface CollectionVersion extends Schema.Schema.Type<typeof CollectionVersion> {}

/**
 * One observation of bytes for a Collection: either its Source, or a local edit the user retained
 * from an installed skill. `revision` is the exact Git commit or Registry Release when there is one.
 */
export const Import = Schema.Struct({
  import_id: ImportId,
  collection_id: CollectionId,
  kind: Schema.Literals(["source", "edit"]),
  collection_version_id: CollectionVersionId,
  source_identity: SourceIdentity,
  /** Where the bytes were read from, for provenance and display. Never parsed back. */
  input: HistoricalLocator,
  revision: Schema.optionalKey(Schema.NonEmptyString),
  imported_at: Schema.String,
  machine_id: MachineId,
  lock_file_entries: Schema.Array(SkillsShLockFileEntry),
});
export interface Import extends Schema.Schema.Type<typeof Import> {}

const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** True only when the acquisition names exact bytes another device can retrieve and verify. */
export const importCanBeRefetched = (acquisition: Import): boolean => {
  if (acquisition.kind !== "source" || acquisition.revision === undefined) return false;
  switch (acquisition.source_identity.kind) {
    case "github":
    case "git":
      return gitObjectId.test(acquisition.revision);
    case "registry":
      return acquisition.revision !== "latest";
    default:
      return false;
  }
};

export const librarySnapshotDigests = (input: {
  readonly collection_versions: readonly CollectionVersion[];
  readonly imports: readonly Import[];
}): string[] =>
  [
    ...new Set(
      input.collection_versions
        .filter(
          (copy) =>
            !input.imports.some(
              (acquisition) =>
                acquisition.collection_version_id === copy.collection_version_id &&
                importCanBeRefetched(acquisition),
            ),
        )
        .map((copy) => copy.digest),
    ),
  ].sort();

/** One enabled item: a whole Collection, which follows its Source, or one Skill. */
export const Enabled = Schema.Union([
  Schema.Struct({ collection: CollectionId }),
  Schema.Struct({ skill: SkillId }),
]);
export type Enabled = typeof Enabled.Type;

const sameEnabled = Schema.toEquivalence(Enabled);

/**
 * Combine several lists of enabled items into one. A Skill item is dropped only when a
 * whole-Collection item already enables it now; a Skill deleted upstream stays enabled by its own
 * item.
 */
export const mergeEnabled = (
  library: LibraryEntities,
  lists: readonly (readonly Enabled[])[],
): Enabled[] => {
  const items = lists.flat();
  const followed = new Set<string>(
    enabledSkillIds(
      library,
      items.filter((item) => "collection" in item),
    ),
  );
  const merged: Enabled[] = [];
  for (const item of items) {
    if (merged.some((other) => sameEnabled(item, other))) continue;
    if ("skill" in item && followed.has(item.skill)) continue;
    merged.push(item);
  }
  return merged;
};

interface LibraryEntities {
  readonly skills: readonly Skill[];
  readonly collection_versions: readonly CollectionVersion[];
  readonly imports: readonly Import[];
}

/**
 * A Collection's imports, newest first. IDs break observation-time ties so serialization
 * and sync normalization cannot change selected content merely by reordering the array.
 */
const collectionImports = (
  library: Pick<LibraryEntities, "imports">,
  collectionId: CollectionId,
): Import[] =>
  library.imports
    .filter((acquisition) => acquisition.collection_id === collectionId)
    .toSorted(
      (left, right) =>
        right.imported_at.localeCompare(left.imported_at) ||
        right.import_id.localeCompare(left.import_id),
    );

/** A Collection's source imports, newest first. */
export const sourceImports = (
  library: Pick<LibraryEntities, "imports">,
  collectionId: CollectionId,
): Import[] =>
  collectionImports(library, collectionId).filter((acquisition) => acquisition.kind === "source");

/** The Skills present in a Collection's latest source import. */
export const currentCollectionSkills = (library: LibraryEntities, collectionId: CollectionId) => {
  const latest = sourceImports(library, collectionId)[0];
  const copy = library.collection_versions.find(
    (candidate) => candidate.collection_version_id === latest?.collection_version_id,
  );
  return library.skills.filter(
    (skill) =>
      skill.collection_id === collectionId &&
      copy?.members.some((member) => member.source_path === skill.path) === true,
  );
};

/**
 * The import and retained bytes behind one Skill Version, newest first. A source import
 * holds the Skill at its path; a retained edit holds the one edited Skill at its root.
 */
export const versionBacking = (library: LibraryEntities, skill: Skill, version: SkillVersion) => {
  for (const acquisition of collectionImports(library, skill.collection_id)) {
    const copy = library.collection_versions.find(
      (candidate) => candidate.collection_version_id === acquisition.collection_version_id,
    );
    const path = acquisition.kind === "source" ? skill.path : ".";
    const member = copy?.members.find((candidate) => candidate.source_path === path);
    if (
      copy !== undefined &&
      member !== undefined &&
      member.source_digest === version.source_digest &&
      member.artifact_digest === version.artifact_digest &&
      member.materialization_profile === version.materialization_profile
    )
      return { acquisition, copy, member };
  }
  return undefined;
};

/**
 * The Version the newest source import that still contains a Skill observed. An import
 * whose bytes this Skill holds no Version for (for example after a merge kept another device's
 * Versions) is skipped rather than leaving the Skill without one.
 */
const lastImportedVersion = (library: LibraryEntities, skill: Skill) => {
  for (const acquisition of sourceImports(library, skill.collection_id)) {
    const member = library.collection_versions
      .find((copy) => copy.collection_version_id === acquisition.collection_version_id)
      ?.members.find((candidate) => candidate.source_path === skill.path);
    const version = skill.versions.find(
      (candidate) => candidate.artifact_digest === member?.artifact_digest,
    );
    if (version !== undefined) return version;
  }
  return undefined;
};

/**
 * The Version a Skill uses: its retained local edit, else what the newest source import that
 * still contains it observed. A Skill deleted upstream keeps its last observed Version.
 */
export const currentSkillVersion = (
  library: LibraryEntities,
  skill: Skill,
): SkillVersion | undefined =>
  skill.local_version_id === undefined
    ? lastImportedVersion(library, skill)
    : skill.versions.find((version) => version.skill_version_id === skill.local_version_id);

/** The Skill IDs a list enables, expanding whole-Collection items to their current Skills. */
export const enabledSkillIds = (
  library: LibraryEntities,
  enabled: readonly Enabled[],
): SkillId[] => [
  ...new Set(
    enabled.flatMap((item) =>
      "skill" in item
        ? [item.skill]
        : currentCollectionSkills(library, item.collection).map((skill) => skill.skill_id),
    ),
  ),
];

const isNested = (left: string, right: string) =>
  left !== "." && right !== "." && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));

export const CURRENT_PORTABLE_LIBRARY_SCHEMA = "skit.library.v8" as const;

export const LibraryManifest = Schema.Struct({
  schema: Schema.Literal(CURRENT_PORTABLE_LIBRARY_SCHEMA),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  collection_versions: Schema.Array(CollectionVersion),
  imports: Schema.Array(Import),
  snapshot_digests: Schema.Array(Digest),
  /** What the account enables for every project. */
  enabled: Schema.Array(Enabled),
}).check(
  Schema.makeFilter((manifest) => {
    const collections = new Set(manifest.collections.map((item) => item.collection_id));
    const skills = new Set(manifest.skills.map((skill) => skill.skill_id));
    const versionIds = manifest.skills.flatMap((skill) =>
      skill.versions.map((version) => version.skill_version_id),
    );
    const copies = new Map(
      manifest.collection_versions.map((copy) => [copy.collection_version_id, copy]),
    );
    if (
      collections.size !== manifest.collections.length ||
      skills.size !== manifest.skills.length ||
      copies.size !== manifest.collection_versions.length ||
      new Set(manifest.imports.map((item) => item.import_id)).size !== manifest.imports.length ||
      new Set(versionIds).size !== versionIds.length
    )
      return {
        path: ["collections"],
        issue: "Duplicate Collection, Skill, import, retained-copy or Version IDs",
      };

    for (const collection of manifest.collections) {
      const owned = manifest.skills.filter(
        (skill) => skill.collection_id === collection.collection_id,
      );
      const paths = owned.map((skill) => skill.path);
      // A Skill whose path moved upstream leaves its old row behind with its retained history, so
      // only the Skills the newest source import still contains must have distinct names.
      const names = currentCollectionSkills(manifest, collection.collection_id).map(
        (skill) => skill.name,
      );
      if (new Set(paths).size !== paths.length || new Set(names).size !== names.length)
        return {
          path: ["skills"],
          issue: `Collection ${collection.label} (${collection.collection_id}) contains duplicate Skill paths or current names`,
        };
      if (
        paths.some((path, index) => paths.slice(index + 1).some((other) => isNested(path, other)))
      )
        return {
          path: ["skills"],
          issue: `Collection ${collection.label} (${collection.collection_id}) contains overlapping Skill paths`,
        };
      if (paths.includes(".") && paths.length !== 1)
        return {
          path: ["skills"],
          issue: `Collection ${collection.label} (${collection.collection_id}) mixes a root Skill with child Skills`,
        };
    }
    for (const [index, collection] of manifest.collections.entries()) {
      const upstream = collection.upstream;
      if (upstream === undefined) continue;
      const duplicate = manifest.collections
        .slice(index + 1)
        .find(
          (other) =>
            other.upstream !== undefined &&
            Schema.toEquivalence(Upstream)(upstream, other.upstream),
        );
      if (duplicate !== undefined)
        return {
          path: ["collections"],
          issue: `Collections ${collection.label} (${collection.collection_id}) and ${duplicate.label} (${duplicate.collection_id}) track the same upstream`,
        };
    }

    for (const acquisition of manifest.imports)
      if (
        !collections.has(acquisition.collection_id) ||
        !copies.has(acquisition.collection_version_id)
      )
        return {
          path: ["imports"],
          issue: `Import ${acquisition.import_id} references missing Collection ${acquisition.collection_id} or retained copy ${acquisition.collection_version_id}`,
        };
    for (const copy of manifest.collection_versions)
      if (
        copy.members.length === 0 ||
        new Set(copy.members.map((member) => member.source_path)).size !== copy.members.length ||
        !manifest.imports.some(
          (acquisition) => acquisition.collection_version_id === copy.collection_version_id,
        )
      )
        return {
          path: ["collection_versions"],
          issue: `Retained copy ${copy.collection_version_id} has invalid members or no owning import`,
        };

    for (const skill of manifest.skills) {
      if (!collections.has(skill.collection_id))
        return {
          path: ["skills"],
          issue: `Skill ${skill.name} (${skill.skill_id}) references missing Collection ${skill.collection_id}`,
        };
      if (
        skill.local_version_id !== undefined &&
        !skill.versions.some((version) => version.skill_version_id === skill.local_version_id)
      )
        return {
          path: ["skills"],
          issue: `Skill ${skill.name} (${skill.skill_id}) selects missing Version ${skill.local_version_id}`,
        };
      for (const version of skill.versions) {
        if (
          skill.versions.filter((other) => other.artifact_digest === version.artifact_digest)
            .length !== 1
        )
          return {
            path: ["skills"],
            issue: `Skill ${skill.name} (${skill.skill_id}) contains more than one Version for ${version.artifact_digest}`,
          };
        // Every retained Version is backed by bytes one of its Collection's imports holds.
        const backed = versionBacking(manifest, skill, version) !== undefined;
        if (!backed)
          return {
            path: ["skills"],
            issue: `Skill ${skill.name} (${skill.skill_id}) Version ${version.skill_version_id} has no retained import backing`,
          };
      }
    }

    if (
      new Set(manifest.snapshot_digests).size !== manifest.snapshot_digests.length ||
      !Schema.toEquivalence(Schema.Array(Schema.String))(
        [...manifest.snapshot_digests].sort(),
        librarySnapshotDigests(manifest),
      )
    )
      return {
        path: ["snapshot_digests"],
        issue: "Snapshot digests do not match the retained copies that require private snapshots",
      };
    if (
      manifest.enabled.some((item, index) =>
        manifest.enabled.slice(index + 1).some((other) => sameEnabled(item, other)),
      )
    )
      return { path: ["enabled"], issue: "The enabled list contains duplicate items" };
    if (
      manifest.enabled.some((item) =>
        "collection" in item ? !collections.has(item.collection) : !skills.has(item.skill),
      )
    )
      return { path: ["enabled"], issue: "The enabled list names a missing Skill or Collection" };
    return true;
  }),
);
export interface LibraryManifest extends Schema.Schema.Type<typeof LibraryManifest> {}

export const currentLibraryManifest = (
  fields: Omit<LibraryManifest, "schema">,
): LibraryManifest => ({ ...fields, schema: CURRENT_PORTABLE_LIBRARY_SCHEMA });

export const RemoteLibrary = Schema.Struct({
  library_id: Schema.String,
  revision_id: Schema.String,
  manifest: LibraryManifest,
});
export interface RemoteLibrary extends Schema.Schema.Type<typeof RemoteLibrary> {}
export const LibraryResponse = Schema.Struct({ library: RemoteLibrary });
export const LibraryWriteRequest = Schema.Struct({
  expected_revision_id: Schema.NullOr(Schema.String),
  manifest: LibraryManifest,
});
export const SnapshotUploadResponse = Schema.Struct({
  library_id: Schema.String,
  snapshot_digest: Digest,
  reused: Schema.Boolean,
});

export const SnapshotArchiveEntry = Schema.Union([
  Schema.Struct({ path: SourceRelativePath, kind: Schema.Literal("directory") }),
  Schema.Struct({
    path: SourceRelativePath,
    kind: Schema.Literal("file"),
    mode: Schema.Literals([0o644, 0o755]),
    content_base64: Schema.String,
  }),
  Schema.Struct({
    path: SourceRelativePath,
    kind: Schema.Literal("symlink"),
    target: Schema.String,
  }),
]);
export type SnapshotArchiveEntry = Schema.Schema.Type<typeof SnapshotArchiveEntry>;

export const SnapshotArchive = Schema.Struct({
  profile: Schema.Literal("verbatim/v1"),
  digest: Digest,
  entries: Schema.Array(SnapshotArchiveEntry),
});
export interface SnapshotArchive extends Schema.Schema.Type<typeof SnapshotArchive> {}
