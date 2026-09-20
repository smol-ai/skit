import { Schema, SchemaGetter } from "effect";
import { LegacyLibraryManifestV2 } from "../distribution/api-contracts.js";
import { canonicalJson } from "../shared/json.js";
import { CollectionId, SkillId, SkillVersionId } from "./entity-ids.js";
import {
  Acquisition,
  Binding,
  Collection,
  CollectionRelativePath,
  CURRENT_PORTABLE_LIBRARY_SCHEMA,
  LibraryManifest,
  RetainedCopy,
  Skill,
  SkillVersion,
  SourceRelativePath,
  Upstream,
} from "./library-contracts.js";
import { Digest, HarnessName } from "./store/state-schema.js";

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

export const LibraryHead = Schema.Struct({
  library_id: Schema.String,
  revision_id: Schema.String,
  manifest: Schema.Union([LibraryManifestAnyVersion, LegacyLibraryManifestV2]),
});
export interface LibraryHead extends Schema.Schema.Type<typeof LibraryHead> {}
export const LibraryReadResponse = Schema.Struct({ library: LibraryHead });
