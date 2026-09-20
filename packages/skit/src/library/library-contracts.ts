import { Schema, SchemaGetter } from "effect";
import { LegacyLibraryManifestV2 } from "../distribution/api-contracts.js";
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
    kind: Schema.Literal("selected-skills"),
    names: Schema.Array(Schema.NonEmptyString).check(
      Schema.makeFilter((names) => names.length > 0 && new Set(names).size === names.length),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("selected-paths"),
    paths: Schema.Array(SourceRelativePath).check(
      Schema.makeFilter((paths) => paths.length > 0 && new Set(paths).size === paths.length),
    ),
  }),
]);
export type AcquisitionSelection = typeof AcquisitionSelection.Type;

export const Upstream = Schema.Struct({
  source_identity: SourceIdentity,
  tracking: SourceTracking,
  selection: AcquisitionSelection,
  last_acquisition_id: Schema.optionalKey(AcquisitionId),
});
export type Upstream = typeof Upstream.Type;

export const SkillsShObservation = Schema.Struct({
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
export interface SkillsShObservation extends Schema.Schema.Type<typeof SkillsShObservation> {}

export const MaterializationProfile = Schema.Literals(["plain-skill/v1", "declared-skit-skill/v1"]);
export type MaterializationProfile = typeof MaterializationProfile.Type;

export const AcquiredOrigin = Schema.Struct({
  acquisition_id: AcquisitionId,
  source_path: CollectionRelativePath,
});
export type AcquiredOrigin = typeof AcquiredOrigin.Type;

export const SkillVersion = Schema.Struct({
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
export interface SkillVersion extends Schema.Schema.Type<typeof SkillVersion> {}

export const Skill = Schema.Struct({
  skill_id: SkillId,
  collection_id: CollectionId,
  path: CollectionRelativePath,
  name: Schema.NonEmptyString,
  selected_skill_version_id: Schema.mutableKey(Schema.optional(SkillVersionId)),
  versions: Schema.mutable(Schema.Array(SkillVersion)),
});
export interface Skill extends Schema.Schema.Type<typeof Skill> {}

export const Collection = Schema.Struct({
  collection_id: CollectionId,
  label: Schema.NonEmptyString,
  upstream: Schema.optionalKey(Upstream),
});
export interface Collection extends Schema.Schema.Type<typeof Collection> {}

export const RetainedCopyMember = Schema.Struct({
  source_path: CollectionRelativePath,
  source_digest: Digest,
  artifact_digest: Digest,
  materialization_profile: MaterializationProfile,
});
export type RetainedCopyMember = typeof RetainedCopyMember.Type;

export const RetainedCopy = Schema.Struct({
  retained_copy_id: RetainedCopyId,
  digest: Digest,
  copy_profile: Schema.Literal("verbatim/v1"),
  members: Schema.Array(RetainedCopyMember),
});
export interface RetainedCopy extends Schema.Schema.Type<typeof RetainedCopy> {}

export const RetainedCopyV4 = Schema.Struct({
  ...RetainedCopy.fields,
  v3_normalized_tree: Schema.optionalKey(
    Schema.Struct({
      digest: Digest,
      profile: Schema.NonEmptyString,
      source_updated_at: Schema.optionalKey(Schema.String),
    }),
  ),
});

export const Acquisition = Schema.Struct({
  acquisition_id: AcquisitionId,
  retained_copy_id: RetainedCopyId,
  source_identity: SourceIdentity,
  tracking: SourceTracking,
  selection: AcquisitionSelection,
  input: HistoricalLocator,
  source_revision: Schema.optionalKey(Schema.String),
  acquired_at: Schema.String,
  machine_id: MachineId,
  observations: Schema.Array(SkillsShObservation),
});
export interface Acquisition extends Schema.Schema.Type<typeof Acquisition> {}

const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const canonicalPinnedGitInput = (acquisition: Acquisition): boolean => {
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
export const acquisitionIsSourceRestorable = (acquisition: Acquisition): boolean => {
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

export const librarySnapshotDigests = (input: {
  readonly retained_copies: readonly RetainedCopy[];
  readonly acquisitions: readonly Acquisition[];
}): string[] =>
  [
    ...new Set(
      input.retained_copies
        .filter(
          (copy) =>
            !input.acquisitions.some(
              (acquisition) =>
                acquisition.retained_copy_id === copy.retained_copy_id &&
                acquisitionIsSourceRestorable(acquisition),
            ),
        )
        .map((copy) => copy.digest),
    ),
  ].sort();

export const Binding = Schema.Struct({
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  skills: Schema.Array(SkillId),
});
export interface Binding extends Schema.Schema.Type<typeof Binding> {}

const isNested = (left: string, right: string) =>
  left !== "." && right !== "." && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`));

export const CURRENT_PORTABLE_LIBRARY_SCHEMA = "skit.library.v5" as const;

export const LibraryManifest = Schema.Struct({
  schema: Schema.Literal(CURRENT_PORTABLE_LIBRARY_SCHEMA),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  retained_copies: Schema.Array(RetainedCopy),
  acquisitions: Schema.Array(Acquisition),
  snapshot_digests: Schema.Array(Digest),
  bindings: Schema.Array(Binding),
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
        const governedAcquisitionIds = new Set(
          owned.flatMap((skill) =>
            skill.versions.flatMap((version) =>
              version.origins.map((origin) => origin.acquisition_id),
            ),
          ),
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
        if (
          collection.upstream?.last_acquisition_id !== undefined &&
          (!acquisitions.has(collection.upstream.last_acquisition_id) ||
            !governedAcquisitionIds.has(collection.upstream.last_acquisition_id))
        )
          return false;
        if (
          collection.upstream?.selection.kind === "selected-skills" &&
          canonicalJson(collection.upstream.selection.names.toSorted()) !==
            canonicalJson(names.toSorted())
        )
          return false;
        if (
          collection.upstream?.selection.kind === "selected-paths" &&
          canonicalJson(
            collection.upstream.selection.paths
              .map((path) =>
                path.endsWith("/SKILL.md") ? path.slice(0, -"/SKILL.md".length) : path,
              )
              .toSorted(),
          ) !== canonicalJson(paths.toSorted())
        )
          return false;
      }
      const upstreamKeys = manifest.collections.flatMap((collection) =>
        collection.upstream === undefined
          ? []
          : [
              canonicalJson({
                source_identity: collection.upstream.source_identity,
                tracking: collection.upstream.tracking,
              }),
            ],
      );
      if (new Set(upstreamKeys).size !== upstreamKeys.length) return false;
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
          canonicalJson(librarySnapshotDigests(manifest))
      )
        return false;
      for (const binding of manifest.bindings) {
        if (
          new Set(binding.skills).size !== binding.skills.length ||
          binding.skills.some((skillId) => !skills.has(skillId))
        )
          return false;
      }
      return (
        new Set(manifest.bindings.map((binding) => binding.harness)).size ===
        manifest.bindings.length
      );
    },
    {
      message:
        "Library Collections, Skills, retained copies, Acquisitions, and Bindings must agree",
    },
  ),
);
export interface LibraryManifest extends Schema.Schema.Type<typeof LibraryManifest> {}

export const currentLibraryManifest = (
  fields: Omit<LibraryManifest, "schema">,
): LibraryManifest => ({ ...fields, schema: CURRENT_PORTABLE_LIBRARY_SCHEMA });

const AcquisitionSelectionV4 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("full-tree") }),
  Schema.Struct({
    kind: Schema.Literal("selected-paths"),
    paths: Schema.Array(SourceRelativePath).check(
      Schema.makeFilter((paths) => paths.length > 0 && new Set(paths).size === paths.length),
    ),
  }),
]);
export const AcquisitionV4 = Schema.Struct({
  ...Acquisition.fields,
  selection: AcquisitionSelectionV4,
});
const UpstreamV4 = Schema.Struct({
  ...Upstream.fields,
  selection: AcquisitionSelectionV4,
});
export const CollectionV4 = Schema.Struct({
  collection_id: CollectionId,
  display_name: Schema.NonEmptyString,
  upstream: Schema.optionalKey(UpstreamV4),
});
export const SkillV4 = Schema.Struct({
  skill_id: SkillId,
  collection_id: CollectionId,
  path: CollectionRelativePath,
  name: Schema.NonEmptyString,
  upstream_path: Schema.optionalKey(CollectionRelativePath),
  selected_skill_version_id: Schema.mutableKey(Schema.optional(SkillVersionId)),
  versions: Schema.mutable(Schema.Array(SkillVersion)),
});
export const BindingV4 = Schema.Struct({
  collection_id: CollectionId,
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  skills: Schema.Array(SkillId),
});
export const LibraryManifestV4 = Schema.Struct({
  schema: Schema.Literal("skit.library.v4"),
  collections: Schema.Array(CollectionV4),
  skills: Schema.Array(SkillV4),
  retained_copies: Schema.Array(RetainedCopyV4),
  acquisitions: Schema.Array(AcquisitionV4),
  snapshot_digests: Schema.Array(Digest),
  bindings: Schema.Array(BindingV4),
});
export type LibraryManifestV4 = typeof LibraryManifestV4.Type;

const legacyWellKnownSelection = (value: string) => {
  const match = value.match(/^wellknown:(.+)#skills=([a-z0-9-]+(?:,[a-z0-9-]+)*)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    input: `wellknown:${match[1]}`,
    names: [...new Set(match[2].split(","))].sort(),
  };
};

export const migrateLibraryEntitiesFromV4 = (input: {
  readonly collections: readonly (typeof CollectionV4.Type)[];
  readonly skills: readonly (typeof SkillV4.Type)[];
  readonly acquisitions: readonly (typeof AcquisitionV4.Type)[];
  readonly bindings: readonly (typeof BindingV4.Type)[];
}): {
  readonly collections: Collection[];
  readonly skills: Skill[];
  readonly acquisitions: Acquisition[];
  readonly bindings: Binding[];
} => {
  const acquisitions = input.acquisitions.map((acquisition): Acquisition => {
    const legacy =
      acquisition.selection.kind === "full-tree"
        ? legacyWellKnownSelection(acquisition.input.value)
        : undefined;
    return {
      ...acquisition,
      ...(legacy === undefined
        ? {}
        : {
            source_identity: {
              kind: "well-known" as const,
              locator: { value: legacy.input.replace(/^wellknown:/, "") },
            },
          }),
      selection:
        legacy === undefined
          ? acquisition.selection
          : { kind: "selected-skills", names: legacy.names },
    };
  });
  const selectionByAcquisition = new Map(
    acquisitions.map((acquisition) => [acquisition.acquisition_id, acquisition.selection]),
  );
  const collectionAcquisitions = (collectionId: CollectionId) => {
    const ids = new Set(
      input.skills
        .filter((skill) => skill.collection_id === collectionId)
        .flatMap((skill) => skill.versions.flatMap((version) => version.origins))
        .map((origin) => origin.acquisition_id),
    );
    return acquisitions.filter((acquisition) => ids.has(acquisition.acquisition_id));
  };
  const rawCollections = input.collections.flatMap((collection): Collection[] => {
    const skills = input.skills.filter((skill) => skill.collection_id === collection.collection_id);
    if (skills.length === 0) return [];
    const matchingAcquisition =
      collection.upstream?.last_acquisition_id === undefined
        ? collectionAcquisitions(collection.collection_id)
            .filter(
              (acquisition) =>
                canonicalJson(acquisition.source_identity) ===
                canonicalJson(collection.upstream?.source_identity),
            )
            .toSorted((left, right) => right.acquired_at.localeCompare(left.acquired_at))[0]
        : acquisitions.find(
            (acquisition) =>
              acquisition.acquisition_id === collection.upstream?.last_acquisition_id,
          );
    const selected =
      matchingAcquisition?.selection ??
      (collection.upstream?.last_acquisition_id === undefined
        ? undefined
        : selectionByAcquisition.get(collection.upstream.last_acquisition_id));
    return [
      {
        collection_id: collection.collection_id,
        label:
          matchingAcquisition?.source_identity.kind === "well-known"
            ? matchingAcquisition.source_identity.locator.value
            : collection.display_name,
        ...(collection.upstream === undefined
          ? {}
          : {
              upstream: {
                ...collection.upstream,
                ...(matchingAcquisition === undefined
                  ? {}
                  : { source_identity: matchingAcquisition.source_identity }),
                selection: selected ?? collection.upstream.selection,
                ...(matchingAcquisition === undefined
                  ? {}
                  : { last_acquisition_id: matchingAcquisition.acquisition_id }),
              },
            }),
      },
    ];
  });
  const rawSkills = input.skills.map((skill): Skill => {
    const { upstream_path: _legacyPath, ...fields } = skill;
    return fields;
  });
  const collectionRemap = new Map<CollectionId, CollectionId>();
  const collectionsByUpstream = new Map<string, Collection>();
  const collections: Collection[] = [];
  for (const collection of rawCollections.toSorted((left, right) =>
    left.collection_id.localeCompare(right.collection_id),
  )) {
    if (collection.upstream === undefined) {
      collections.push(collection);
      collectionRemap.set(collection.collection_id, collection.collection_id);
      continue;
    }
    const key = canonicalJson({
      source_identity: collection.upstream.source_identity,
      tracking: collection.upstream.tracking,
    });
    const prior = collectionsByUpstream.get(key);
    if (prior === undefined) {
      collectionsByUpstream.set(key, collection);
      collections.push(collection);
      collectionRemap.set(collection.collection_id, collection.collection_id);
      continue;
    }
    const left = prior.upstream!.selection;
    const right = collection.upstream.selection;
    const selection =
      left.kind === "selected-skills" && right.kind === "selected-skills"
        ? {
            kind: "selected-skills" as const,
            names: [...new Set([...left.names, ...right.names])].sort(),
          }
        : left.kind === "selected-paths" && right.kind === "selected-paths"
          ? {
              kind: "selected-paths" as const,
              paths: [...new Set([...left.paths, ...right.paths])].sort(),
            }
          : left;
    const revised = { ...prior, upstream: { ...prior.upstream!, selection } };
    collections[collections.indexOf(prior)] = revised;
    collectionsByUpstream.set(key, revised);
    collectionRemap.set(collection.collection_id, prior.collection_id);
  }
  const skills = rawSkills.map((skill): Skill => ({
    ...skill,
    collection_id: collectionRemap.get(skill.collection_id) ?? skill.collection_id,
  }));
  const bindingsByHarness = new Map<string, Binding>();
  for (const binding of input.bindings) {
    const prior = bindingsByHarness.get(binding.harness);
    bindingsByHarness.set(binding.harness, {
      harness: binding.harness,
      scope: { kind: "global" },
      skills: [...new Set([...(prior?.skills ?? []), ...binding.skills])],
    });
  }
  return { collections, skills, acquisitions, bindings: [...bindingsByHarness.values()] };
};

const LibraryManifestFromV4 = LibraryManifestV4.pipe(
  Schema.decodeTo(LibraryManifest, {
    decode: SchemaGetter.transform((manifest) => {
      const migrated = migrateLibraryEntitiesFromV4(manifest);
      return {
        ...manifest,
        schema: CURRENT_PORTABLE_LIBRARY_SCHEMA,
        collections: migrated.collections,
        skills: migrated.skills,
        retained_copies: manifest.retained_copies.map(
          ({ v3_normalized_tree: _legacyNormalizedTree, ...copy }) => copy,
        ),
        acquisitions: migrated.acquisitions,
        bindings: migrated.bindings,
      };
    }),
    encode: SchemaGetter.forbidden(() => "v4 portable Library manifests are decode-only"),
  }),
);

/** Accept every supported wire version and expose only the current manifest model. */
export const LibraryManifestAnyVersion = Schema.Union([LibraryManifest, LibraryManifestFromV4]);

export const LibraryReceipt = Schema.Struct({
  library_id: Schema.String,
  revision_id: Schema.String,
  manifest: LibraryManifest,
});
export interface LibraryReceipt extends Schema.Schema.Type<typeof LibraryReceipt> {}
export const LibraryResponse = Schema.Struct({ library: LibraryReceipt });
export const LibraryHead = Schema.Struct({
  library_id: Schema.String,
  revision_id: Schema.String,
  manifest: Schema.Union([LibraryManifestAnyVersion, LegacyLibraryManifestV2]),
});
export interface LibraryHead extends Schema.Schema.Type<typeof LibraryHead> {}
export const LibraryReadResponse = Schema.Struct({ library: LibraryHead });
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
