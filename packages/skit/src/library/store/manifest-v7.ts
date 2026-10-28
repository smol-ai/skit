import { Schema, SchemaGetter } from "effect";
import { CollectionId, CollectionVersionId, ImportId, MachineId, SkillId } from "../entity-ids.js";
import {
  Collection,
  type CollectionVersion,
  CollectionVersionSkill,
  CURRENT_PORTABLE_LIBRARY_SCHEMA,
  type Enabled,
  HistoricalLocator,
  type Import,
  LibraryManifest,
  Skill,
  SkillsShLockFileEntry,
  SourceIdentity,
} from "../library-contracts.js";
import { Digest } from "../../vocabulary.js";

// Frozen `skit.library.v7`. Every older manifest and Library state migrates through these shapes,
// so they and the helpers below stay as v7 defined them while the current model moves on.

export const CollectionVersionV7 = Schema.Struct({
  retained_copy_id: CollectionVersionId,
  digest: Digest,
  copy_profile: Schema.Literal("verbatim/v1"),
  members: Schema.Array(CollectionVersionSkill),
});
export type CollectionVersionV7 = typeof CollectionVersionV7.Type;

export const ImportV7 = Schema.Struct({
  acquisition_id: ImportId,
  collection_id: CollectionId,
  kind: Schema.Literals(["source", "retained-edit"]),
  retained_copy_id: CollectionVersionId,
  source_identity: SourceIdentity,
  input: HistoricalLocator,
  revision: Schema.optionalKey(Schema.NonEmptyString),
  acquired_at: Schema.String,
  machine_id: MachineId,
  observations: Schema.Array(SkillsShLockFileEntry),
});
export type ImportV7 = typeof ImportV7.Type;

export const BindingEntryV7 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("collection"), collection_id: CollectionId }),
  Schema.Struct({ kind: Schema.Literal("skill"), skill_id: SkillId }),
]);
export type BindingEntryV7 = typeof BindingEntryV7.Type;

export const BindingV7 = Schema.Struct({
  scope: Schema.Struct({ kind: Schema.Literal("global") }),
  entries: Schema.Array(BindingEntryV7),
});
export type BindingV7 = typeof BindingV7.Type;

export const LibraryManifestV7 = Schema.Struct({
  schema: Schema.Literal("skit.library.v7"),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  retained_copies: Schema.Array(CollectionVersionV7),
  acquisitions: Schema.Array(ImportV7),
  snapshot_digests: Schema.Array(Digest),
  bindings: Schema.Array(BindingV7),
});
export type LibraryManifestV7 = typeof LibraryManifestV7.Type;

interface LibraryEntitiesV7 {
  readonly skills: readonly Skill[];
  readonly retained_copies: readonly CollectionVersionV7[];
  readonly acquisitions: readonly ImportV7[];
}

const sourceImportsV7 = (library: Pick<LibraryEntitiesV7, "acquisitions">, collectionId: string) =>
  library.acquisitions
    .filter(
      (acquisition) => acquisition.collection_id === collectionId && acquisition.kind === "source",
    )
    .toSorted(
      (left, right) =>
        right.acquired_at.localeCompare(left.acquired_at) ||
        right.acquisition_id.localeCompare(left.acquisition_id),
    );

/** The Skills present in a Collection's latest source import. */
export const currentCollectionSkillsV7 = (library: LibraryEntitiesV7, collectionId: string) => {
  const latest = sourceImportsV7(library, collectionId)[0];
  const copy = library.retained_copies.find(
    (candidate) => candidate.retained_copy_id === latest?.retained_copy_id,
  );
  return library.skills.filter(
    (skill) =>
      skill.collection_id === collectionId &&
      copy?.members.some((member) => member.source_path === skill.path) === true,
  );
};

const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const importCanBeRefetchedV7 = (acquisition: ImportV7): boolean => {
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

/** Digests of the retained copies no import can refetch, so they travel as private snapshots. */
export const librarySnapshotDigestsV7 = (input: {
  readonly retained_copies: readonly CollectionVersionV7[];
  readonly acquisitions: readonly ImportV7[];
}): string[] =>
  [
    ...new Set(
      input.retained_copies
        .filter(
          (copy) =>
            !input.acquisitions.some(
              (acquisition) =>
                acquisition.retained_copy_id === copy.retained_copy_id &&
                importCanBeRefetchedV7(acquisition),
            ),
        )
        .map((copy) => copy.digest),
    ),
  ].sort();

/** The Skill IDs a Binding enables, expanding whole-Collection entries to their current Skills. */
export const bindingSkillIdsV7 = (
  library: LibraryEntitiesV7,
  binding: { readonly entries: readonly BindingEntryV7[] },
): SkillId[] => [
  ...new Set(
    binding.entries.flatMap((entry) =>
      entry.kind === "skill"
        ? [entry.skill_id]
        : currentCollectionSkillsV7(library, entry.collection_id).map((skill) => skill.skill_id),
    ),
  ),
];

/**
 * Combine the entries of several Bindings into one. A Skill entry is dropped only when a
 * whole-Collection entry already enables it; a Skill deleted upstream stays enabled by its own entry.
 */
export const mergeBindingEntriesV7 = (
  library: LibraryEntitiesV7,
  bindings: readonly { readonly entries: readonly BindingEntryV7[] }[],
): BindingEntryV7[] => {
  const entries = bindings.flatMap((binding) => binding.entries);
  const followed = new Set<string>(
    bindingSkillIdsV7(library, {
      entries: entries.filter((entry) => entry.kind === "collection"),
    }),
  );
  const merged: BindingEntryV7[] = [];
  for (const entry of entries) {
    if (merged.some((other) => Schema.toEquivalence(BindingEntryV7)(entry, other))) continue;
    if (entry.kind === "skill" && followed.has(entry.skill_id)) continue;
    merged.push(entry);
  }
  return merged;
};

/** The single global Binding that per-Harness global Bindings become, if any enable something. */
export const mergeGlobalBindingsV7 = (
  library: LibraryEntitiesV7,
  bindings: readonly { readonly entries: readonly BindingEntryV7[] }[],
): BindingV7[] => {
  const entries = mergeBindingEntriesV7(library, bindings);
  return entries.length === 0 ? [] : [{ scope: { kind: "global" }, entries }];
};

/** v7 → v8: enabled items lose their `kind`, and stored entities take plain names. */
export const enabledFromV7 = (entries: readonly BindingEntryV7[]): Enabled[] =>
  entries.map((entry) =>
    entry.kind === "skill" ? { skill: entry.skill_id } : { collection: entry.collection_id },
  );

export const collectionVersionFromV7 = ({
  retained_copy_id,
  ...copy
}: CollectionVersionV7): CollectionVersion => ({
  ...copy,
  collection_version_id: retained_copy_id,
});

export const importFromV7 = ({
  acquisition_id,
  kind,
  retained_copy_id,
  acquired_at,
  observations,
  ...fields
}: ImportV7): Import => ({
  ...fields,
  import_id: acquisition_id,
  kind: kind === "retained-edit" ? "edit" : "source",
  collection_version_id: retained_copy_id,
  imported_at: acquired_at,
  lock_file_entries: observations,
});

export const libraryManifestFromV7 = ({
  schema: _schema,
  retained_copies,
  acquisitions,
  bindings,
  ...fields
}: LibraryManifestV7) => ({
  ...fields,
  schema: CURRENT_PORTABLE_LIBRARY_SCHEMA,
  collection_versions: retained_copies.map(collectionVersionFromV7),
  imports: acquisitions.map(importFromV7),
  enabled: enabledFromV7(bindings.flatMap((binding) => binding.entries)),
});

export const LibraryManifestFromV7 = LibraryManifestV7.pipe(
  Schema.decodeTo(LibraryManifest, {
    decode: SchemaGetter.transform(libraryManifestFromV7),
    encode: SchemaGetter.forbidden(() => "v7 portable Library manifests are decode-only"),
  }),
);
