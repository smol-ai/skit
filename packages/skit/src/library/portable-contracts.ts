import { Schema } from "effect";
import { LibraryManifest } from "../distribution/api-contracts.js";
import { canonicalJson } from "../shared/json.js";
import {
  AcquisitionId,
  CollectionId,
  MachineId,
  RetainedCopyId,
  SkillId,
  SkillVersionId,
} from "./entity-ids.js";
import { Digest, HarnessName } from "./store/state-schema.js";

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
export const HistoricalPath = HistoricalLocator;
export interface HistoricalPath extends Schema.Schema.Type<typeof HistoricalPath> {}

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
    path: HistoricalPath,
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

export const SourceTracking = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("default") }),
  Schema.Struct({ kind: Schema.Literal("branch"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("tag"), ref: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("commit"), ref: Schema.NonEmptyString }),
]);
export type SourceTracking = typeof SourceTracking.Type;

export const AcquisitionSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("full-tree") }),
  Schema.Struct({
    kind: Schema.Literal("selected-paths"),
    paths: Schema.Array(SourceRelativePath).check(
      Schema.makeFilter((paths) => paths.length > 0 && new Set(paths).size === paths.length),
    ),
  }),
]);
export type AcquisitionSelection = typeof AcquisitionSelection.Type;

export const CollectionUpstream = Schema.Struct({
  source_identity: SourceIdentity,
  tracking: SourceTracking,
  selection: AcquisitionSelection,
  last_acquisition_id: Schema.optionalKey(AcquisitionId),
});
export type CollectionUpstream = typeof CollectionUpstream.Type;

export const PortableSkillsShObservation = Schema.Struct({
  type: Schema.Literal("skills.sh-lock"),
  machine_id: MachineId,
  observed_at: Schema.String,
  source_updated_at: Schema.optionalKey(Schema.String),
  lock_path: HistoricalPath,
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
export interface PortableSkillsShObservation extends Schema.Schema.Type<
  typeof PortableSkillsShObservation
> {}

export const MaterializationProfile = Schema.Literals(["plain-skill/v1", "declared-skit-skill/v1"]);
export type MaterializationProfile = typeof MaterializationProfile.Type;

export const AcquiredOrigin = Schema.Struct({
  acquisition_id: AcquisitionId,
  source_path: CollectionRelativePath,
});
export type AcquiredOrigin = typeof AcquiredOrigin.Type;

export const PortableSkillVersion = Schema.Struct({
  skill_version_id: SkillVersionId,
  source_digest: Digest,
  artifact_digest: Digest,
  validation_identity_digest: Digest,
  materialization_profile: MaterializationProfile,
  origins: Schema.Array(AcquiredOrigin).check(
    Schema.makeFilter(
      (origins) =>
        origins.length > 0 &&
        new Set(origins.map((origin) => `${origin.acquisition_id}\0${origin.source_path}`)).size ===
          origins.length,
      { message: "Skill Version origins must be non-empty and unique" },
    ),
  ),
});
export interface PortableSkillVersion extends Schema.Schema.Type<typeof PortableSkillVersion> {}

export const PortableSkill = Schema.Struct({
  skill_id: SkillId,
  collection_id: CollectionId,
  path: CollectionRelativePath,
  name: Schema.NonEmptyString,
  upstream_path: Schema.optionalKey(CollectionRelativePath),
  selected_skill_version_id: Schema.mutableKey(Schema.optional(SkillVersionId)),
  versions: Schema.mutable(Schema.Array(PortableSkillVersion)),
});
export interface PortableSkill extends Schema.Schema.Type<typeof PortableSkill> {}

export const PortableCollection = Schema.Struct({
  collection_id: CollectionId,
  display_name: Schema.NonEmptyString,
  upstream: Schema.optionalKey(CollectionUpstream),
});
export interface PortableCollection extends Schema.Schema.Type<typeof PortableCollection> {}

export const PortableRetainedCopyMember = Schema.Struct({
  source_path: CollectionRelativePath,
  source_digest: Digest,
  artifact_digest: Digest,
  materialization_profile: MaterializationProfile,
});
export type PortableRetainedCopyMember = typeof PortableRetainedCopyMember.Type;

export const PortableRetainedCopy = Schema.Struct({
  retained_copy_id: RetainedCopyId,
  digest: Digest,
  copy_profile: Schema.Literal("verbatim/v1"),
  members: Schema.Array(PortableRetainedCopyMember),
  v3_normalized_tree: Schema.optionalKey(
    Schema.Struct({
      digest: Digest,
      profile: Schema.NonEmptyString,
      source_updated_at: Schema.optionalKey(Schema.String),
    }),
  ),
});
export interface PortableRetainedCopy extends Schema.Schema.Type<typeof PortableRetainedCopy> {}

export const PortableAcquisition = Schema.Struct({
  acquisition_id: AcquisitionId,
  retained_copy_id: RetainedCopyId,
  source_identity: SourceIdentity,
  tracking: SourceTracking,
  selection: AcquisitionSelection,
  input: HistoricalLocator,
  source_revision: Schema.optionalKey(Schema.String),
  acquired_at: Schema.String,
  machine_id: MachineId,
  observations: Schema.Array(PortableSkillsShObservation),
});
export interface PortableAcquisition extends Schema.Schema.Type<typeof PortableAcquisition> {}

const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const canonicalPinnedGitInput = (acquisition: PortableAcquisition): boolean => {
  if (acquisition.source_identity.kind === "github") {
    const parsed = URL.parse(acquisition.input.value);
    if (parsed === null || parsed.hash || parsed.search) return false;
    const path = parsed.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    return (
      parsed.hostname === "github.com" &&
      path === `${acquisition.source_identity.owner}/${acquisition.source_identity.repository}`
    );
  }
  if (acquisition.source_identity.kind === "git")
    return acquisition.input.value === acquisition.source_identity.remote.value;
  return false;
};

/** True only when the acquisition names exact bytes another device can retrieve and verify. */
export const portableAcquisitionIsSourceRestorable = (
  acquisition: PortableAcquisition,
): boolean => {
  if (acquisition.source_identity.kind === "github" || acquisition.source_identity.kind === "git")
    return (
      acquisition.source_revision !== undefined &&
      gitObjectId.test(acquisition.source_revision) &&
      acquisition.tracking.kind === "commit" &&
      acquisition.tracking.ref === acquisition.source_revision &&
      canonicalPinnedGitInput(acquisition)
    );
  if (acquisition.source_identity.kind !== "registry") return false;
  const version = acquisition.input.value.match(/@([^/@]+)$/)?.[1];
  return version !== undefined && version !== "latest";
};

export const portableSnapshotDigests = (input: {
  readonly retained_copies: readonly PortableRetainedCopy[];
  readonly acquisitions: readonly PortableAcquisition[];
}): string[] =>
  [
    ...new Set(
      input.retained_copies
        .filter(
          (copy) =>
            !input.acquisitions.some(
              (acquisition) =>
                acquisition.retained_copy_id === copy.retained_copy_id &&
                portableAcquisitionIsSourceRestorable(acquisition),
            ),
        )
        .map((copy) => copy.digest),
    ),
  ].sort();

export const PortableBinding = Schema.Struct({
  collection_id: CollectionId,
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  skills: Schema.Array(SkillId),
});
export interface PortableBinding extends Schema.Schema.Type<typeof PortableBinding> {}

const isNested = (left: string, right: string) =>
  left !== "." && right !== "." && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));

export const PortableLibraryManifest = Schema.Struct({
  schema: Schema.Literal("skit.library.v4"),
  collections: Schema.Array(PortableCollection),
  skills: Schema.Array(PortableSkill),
  retained_copies: Schema.Array(PortableRetainedCopy),
  acquisitions: Schema.Array(PortableAcquisition),
  snapshot_digests: Schema.Array(Digest),
  bindings: Schema.Array(PortableBinding),
}).check(
  Schema.makeFilter(
    (manifest) => {
      const collections = new Map(
        manifest.collections.map((collection) => [collection.collection_id, collection]),
      );
      const skills = new Map(manifest.skills.map((skill) => [skill.skill_id, skill]));
      const versions = manifest.skills.flatMap((skill) =>
        skill.versions.map((version) => ({ skill, version })),
      );
      const versionIds = versions.map(({ version }) => version.skill_version_id);
      const copies = new Map(manifest.retained_copies.map((copy) => [copy.retained_copy_id, copy]));
      const acquisitions = new Map(
        manifest.acquisitions.map((acquisition) => [acquisition.acquisition_id, acquisition]),
      );
      if (
        collections.size !== manifest.collections.length ||
        skills.size !== manifest.skills.length ||
        copies.size !== manifest.retained_copies.length ||
        acquisitions.size !== manifest.acquisitions.length ||
        new Set(versionIds).size !== versionIds.length
      )
        return false;

      for (const collection of manifest.collections) {
        const owned = manifest.skills.filter(
          (skill) => skill.collection_id === collection.collection_id,
        );
        if (owned.length === 0) return false;
        const paths = owned.map((skill) => skill.path);
        const names = owned.map((skill) => skill.name);
        if (new Set(paths).size !== paths.length || new Set(names).size !== names.length)
          return false;
        if (
          paths.some((path, index) => paths.slice(index + 1).some((other) => isNested(path, other)))
        )
          return false;
        if (paths.includes(".") && paths.length !== 1) return false;
        const upstreamPaths = owned.flatMap((skill) =>
          skill.upstream_path === undefined ? [] : [skill.upstream_path],
        );
        if (
          (collection.upstream === undefined && upstreamPaths.length > 0) ||
          new Set(upstreamPaths).size !== upstreamPaths.length ||
          (collection.upstream?.last_acquisition_id !== undefined &&
            !acquisitions.has(collection.upstream.last_acquisition_id))
        )
          return false;
      }
      if (manifest.skills.some((skill) => !collections.has(skill.collection_id))) return false;

      for (const { skill, version } of versions) {
        if (
          skill.selected_skill_version_id !== undefined &&
          !skill.versions.some(
            (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
          )
        )
          return false;
        if (
          skill.versions.filter(
            (candidate) => candidate.artifact_digest === version.artifact_digest,
          ).length !== 1
        )
          return false;
        for (const origin of version.origins) {
          const acquisition = acquisitions.get(origin.acquisition_id);
          const copy =
            acquisition === undefined ? undefined : copies.get(acquisition.retained_copy_id);
          const member = copy?.members.find(
            (candidate) => candidate.source_path === origin.source_path,
          );
          if (
            member === undefined ||
            member.source_digest !== version.source_digest ||
            member.artifact_digest !== version.artifact_digest ||
            member.materialization_profile !== version.materialization_profile
          )
            return false;
        }
      }
      for (const copy of manifest.retained_copies) {
        if (
          copy.members.length === 0 ||
          new Set(copy.members.map((member) => member.source_path)).size !== copy.members.length ||
          !manifest.acquisitions.some(
            (acquisition) => acquisition.retained_copy_id === copy.retained_copy_id,
          )
        )
          return false;
      }
      if (manifest.acquisitions.some((acquisition) => !copies.has(acquisition.retained_copy_id)))
        return false;
      if (
        new Set(manifest.snapshot_digests).size !== manifest.snapshot_digests.length ||
        canonicalJson([...manifest.snapshot_digests].sort()) !==
          canonicalJson(portableSnapshotDigests(manifest))
      )
        return false;
      for (const binding of manifest.bindings) {
        if (
          !collections.has(binding.collection_id) ||
          new Set(binding.skills).size !== binding.skills.length ||
          binding.skills.some(
            (skillId) => skills.get(skillId)?.collection_id !== binding.collection_id,
          )
        )
          return false;
      }
      return (
        new Set(manifest.bindings.map((binding) => `${binding.collection_id}\0${binding.harness}`))
          .size === manifest.bindings.length
      );
    },
    {
      message:
        "Library Collections, Skills, retained copies, Acquisitions, and Bindings must agree",
    },
  ),
);
export interface PortableLibraryManifest extends Schema.Schema.Type<
  typeof PortableLibraryManifest
> {}

export const PortableLibraryReceipt = Schema.Struct({
  library_id: Schema.String,
  revision_id: Schema.String,
  manifest: PortableLibraryManifest,
});
export interface PortableLibraryReceipt extends Schema.Schema.Type<typeof PortableLibraryReceipt> {}
export const PortableLibraryResponse = Schema.Struct({ library: PortableLibraryReceipt });
export const PortableLibraryHead = Schema.Struct({
  library_id: Schema.String,
  revision_id: Schema.String,
  manifest: Schema.Union([PortableLibraryManifest, LibraryManifest]),
});
export interface PortableLibraryHead extends Schema.Schema.Type<typeof PortableLibraryHead> {}
export const PortableLibraryReadResponse = Schema.Struct({ library: PortableLibraryHead });
export const PortableLibraryWriteRequest = Schema.Struct({
  expected_revision_id: Schema.NullOr(Schema.String),
  manifest: PortableLibraryManifest,
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
