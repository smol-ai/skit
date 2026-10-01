import { Schema, SchemaGetter } from "effect";
import {
  AcquisitionId,
  CollectionId,
  MachineId,
  RetainedCopyId,
  SkillId,
  SkillVersionId,
} from "./entity-ids.js";
import {
  type Acquisition,
  type BindingEntry,
  type Collection,
  CollectionRelativePath,
  currentCollectionSkills,
  CURRENT_PORTABLE_LIBRARY_SCHEMA,
  HistoricalLocator,
  LibraryManifest,
  librarySnapshotDigests,
  mergeGlobalBindings,
  MaterializationProfile,
  RetainedCopy,
  type Skill,
  SkillsShObservation,
  SourceIdentity,
  SourceRelativePath,
  SourceTracking,
} from "./library-contracts.js";
import { Digest, HarnessName } from "./store/state-schema.js";

/** Frozen `skit.library.v5` entities, decoded only to migrate them to the current model. */
export const AcquisitionSelectionV5 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("full-tree") }),
  Schema.Struct({
    kind: Schema.Literal("selected-skills"),
    names: Schema.Array(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("selected-paths"),
    paths: Schema.Array(SourceRelativePath),
  }),
]);
export type AcquisitionSelectionV5 = typeof AcquisitionSelectionV5.Type;

export const UpstreamV5 = Schema.Struct({
  source_identity: SourceIdentity,
  tracking: SourceTracking,
  selection: AcquisitionSelectionV5,
  last_acquisition_id: Schema.optionalKey(AcquisitionId),
});
export const CollectionV5 = Schema.Struct({
  collection_id: CollectionId,
  label: Schema.NonEmptyString,
  upstream: Schema.optionalKey(UpstreamV5),
});
export type CollectionV5 = typeof CollectionV5.Type;

export const SkillVersionV5 = Schema.Struct({
  skill_version_id: SkillVersionId,
  source_digest: Digest,
  artifact_digest: Digest,
  validation_identity_digest: Digest,
  materialization_profile: MaterializationProfile,
  origins: Schema.Array(
    Schema.Struct({ acquisition_id: AcquisitionId, source_path: CollectionRelativePath }),
  ),
});
export const SkillV5 = Schema.Struct({
  skill_id: SkillId,
  collection_id: CollectionId,
  path: CollectionRelativePath,
  name: Schema.NonEmptyString,
  selected_skill_version_id: Schema.optional(SkillVersionId),
  versions: Schema.Array(SkillVersionV5),
});
export type SkillV5 = typeof SkillV5.Type;

export const AcquisitionV5 = Schema.Struct({
  acquisition_id: AcquisitionId,
  retained_copy_id: RetainedCopyId,
  source_identity: SourceIdentity,
  tracking: SourceTracking,
  selection: AcquisitionSelectionV5,
  input: HistoricalLocator,
  source_revision: Schema.optionalKey(Schema.String),
  acquired_at: Schema.String,
  machine_id: MachineId,
  observations: Schema.Array(SkillsShObservation),
});
export type AcquisitionV5 = typeof AcquisitionV5.Type;

export const BindingV5 = Schema.Struct({
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  skills: Schema.Array(SkillId),
});

export const LibraryManifestV5 = Schema.Struct({
  schema: Schema.Literal("skit.library.v5"),
  collections: Schema.Array(CollectionV5),
  skills: Schema.Array(SkillV5),
  retained_copies: Schema.Array(RetainedCopy),
  acquisitions: Schema.Array(AcquisitionV5),
  snapshot_digests: Schema.Array(Digest),
  bindings: Schema.Array(BindingV5),
});
export type LibraryManifestV5 = typeof LibraryManifestV5.Type;

export interface LibraryEntitiesV5 {
  readonly collections: readonly CollectionV5[];
  readonly skills: readonly SkillV5[];
  readonly retained_copies: readonly RetainedCopy[];
  readonly acquisitions: readonly AcquisitionV5[];
}

/**
 * Migrate v5 entities to the model that keeps user choices apart from observations.
 *
 * - A Collection's upstream keeps only its Source and tracking; selections are dropped, so every
 *   Source is the whole repository.
 * - Each Acquisition names its Collection and whether it observed the Source or retained a local
 *   edit. A selected retained edit becomes the Skill's `local_version_id`.
 * - Bindings become entries: when every Skill of a Collection's latest Acquisition is bound, the
 *   Collection is bound; otherwise each Skill is bound individually.
 */
export const migrateLibraryEntitiesFromV5 = (input: LibraryEntitiesV5) => {
  const collectionOf = new Map<string, CollectionId>();
  for (const skill of input.skills)
    for (const version of skill.versions)
      for (const origin of version.origins)
        collectionOf.set(origin.acquisition_id, skill.collection_id);
  const oldestFirst = input.acquisitions
    .filter((acquisition) => collectionOf.has(acquisition.acquisition_id))
    .toSorted((left, right) => left.acquired_at.localeCompare(right.acquired_at));

  // A Collection's Source is its upstream, or for a local Collection its first Acquisition. Any
  // other Acquisition of that Collection retained a local edit from a Projection path.
  const kindOf = new Map<string, Acquisition["kind"]>();
  for (const collection of input.collections) {
    const owned = oldestFirst.filter(
      (acquisition) => collectionOf.get(acquisition.acquisition_id) === collection.collection_id,
    );
    const source = collection.upstream?.source_identity ?? owned[0]?.source_identity;
    for (const acquisition of owned)
      kindOf.set(
        acquisition.acquisition_id,
        source !== undefined &&
          Schema.toEquivalence(SourceIdentity)(acquisition.source_identity, source)
          ? "source"
          : "retained-edit",
      );
  }

  const acquisitions: Acquisition[] = oldestFirst.map((acquisition) => {
    const git =
      acquisition.source_identity.kind === "github" || acquisition.source_identity.kind === "git";
    // v5 recorded a Registry Release version only in the input locator.
    const release =
      acquisition.source_identity.kind === "registry"
        ? acquisition.input.value.match(/@([^/@]+)$/)?.[1]
        : undefined;
    const revision = git ? acquisition.source_revision : release === "latest" ? undefined : release;
    return {
      acquisition_id: acquisition.acquisition_id,
      collection_id: collectionOf.get(acquisition.acquisition_id)!,
      kind: kindOf.get(acquisition.acquisition_id)!,
      retained_copy_id: acquisition.retained_copy_id,
      source_identity: acquisition.source_identity,
      input: acquisition.input,
      ...(revision === undefined || revision === "" ? {} : { revision }),
      acquired_at: acquisition.acquired_at,
      machine_id: acquisition.machine_id,
      observations: acquisition.observations,
    };
  });
  const skills: Skill[] = input.skills.map((skill) => {
    const selected = skill.versions.find(
      (version) => version.skill_version_id === skill.selected_skill_version_id,
    );
    const selectedEdit =
      selected !== undefined &&
      selected.origins.length > 0 &&
      selected.origins.every((origin) => kindOf.get(origin.acquisition_id) === "retained-edit");
    return {
      skill_id: skill.skill_id,
      collection_id: skill.collection_id,
      path: skill.path,
      name: skill.name,
      ...(selectedEdit ? { local_version_id: selected.skill_version_id } : {}),
      versions: skill.versions.map(({ origins: _origins, ...version }) => version),
    };
  });
  const collections: Collection[] = input.collections.map((collection) => ({
    collection_id: collection.collection_id,
    label: collection.label,
    ...(collection.upstream === undefined
      ? {}
      : {
          upstream: {
            source_identity: collection.upstream.source_identity,
            tracking: collection.upstream.tracking,
          },
        }),
  }));
  const migrated = { collections, skills, acquisitions, retained_copies: input.retained_copies };

  const entries = (skillIds: readonly string[]): BindingEntry[] => {
    const bound = new Set(skillIds);
    const result: BindingEntry[] = [];
    for (const collection of collections) {
      const current = currentCollectionSkills(migrated, collection.collection_id).map(
        (skill) => skill.skill_id,
      );
      if (current.length > 0 && current.every((skillId) => bound.has(skillId))) {
        result.push({ kind: "collection", collection_id: collection.collection_id });
        for (const skillId of current) bound.delete(skillId);
      }
    }
    for (const skill of skills)
      if (bound.has(skill.skill_id)) result.push({ kind: "skill", skill_id: skill.skill_id });
    return result;
  };

  return { ...migrated, entries };
};

export const LibraryManifestFromV5 = LibraryManifestV5.pipe(
  Schema.decodeTo(LibraryManifest, {
    decode: SchemaGetter.transform((manifest) => {
      const migrated = migrateLibraryEntitiesFromV5(manifest);
      return {
        schema: CURRENT_PORTABLE_LIBRARY_SCHEMA,
        collections: migrated.collections,
        skills: migrated.skills,
        retained_copies: migrated.retained_copies,
        acquisitions: migrated.acquisitions,
        snapshot_digests: librarySnapshotDigests(migrated),
        bindings: mergeGlobalBindings(
          migrated,
          manifest.bindings.map((binding) => ({ entries: migrated.entries(binding.skills) })),
        ),
      };
    }),
    encode: SchemaGetter.forbidden(() => "v5 portable Library manifests are decode-only"),
  }),
);
