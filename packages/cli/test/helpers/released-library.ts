import type { LibraryFixtureState } from "./library-home.js";

type Catalogue = {
  readonly [Field in "skills" | "collection_versions" | "imports"]: Readonly<
    LibraryFixtureState[Field]
  >;
};

const catalogue = ({ skills, collection_versions, imports }: Catalogue) => ({
  skills: skills.map(({ versions, ...skill }) => ({
    ...skill,
    versions: versions.map(
      ({ source_hash, artifact_hash, validation_identity_hash, ...version }) => ({
        ...version,
        source_digest: source_hash,
        artifact_digest: artifact_hash,
        validation_identity_digest: validation_identity_hash,
      }),
    ),
  })),
  retained_copies: collection_versions.map(({ collection_version_id, hash, members, ...copy }) => ({
    ...copy,
    retained_copy_id: collection_version_id,
    digest: hash,
    members: members.map(({ source_hash, artifact_hash, ...member }) => ({
      ...member,
      source_digest: source_hash,
      artifact_digest: artifact_hash,
    })),
  })),
  acquisitions: imports.map(
    ({ import_id, kind, collection_version_id, imported_at, lock_file_entries, ...item }) => ({
      ...item,
      acquisition_id: import_id,
      kind: kind === "edit" ? "retained-edit" : kind,
      retained_copy_id: collection_version_id,
      acquired_at: imported_at,
      observations: lock_file_entries.map(
        ({ read_at, original_entry_hash, well_known_hash, ...entry }) => ({
          ...entry,
          observed_at: read_at,
          original_entry_digest: original_entry_hash,
          ...(well_known_hash === undefined ? {} : { well_known_digest: well_known_hash }),
        }),
      ),
    }),
  ),
});

const entries = (enabled: Readonly<LibraryFixtureState["enabled"]>) =>
  enabled.map((item) =>
    "skill" in item
      ? { kind: "skill", skill_id: item.skill }
      : { kind: "collection", collection_id: item.collection },
  );

const binding = (enabled: Readonly<LibraryFixtureState["enabled"]>) => ({
  scope: { kind: "global" },
  entries: entries(enabled),
});

export const asV9 = (state: LibraryFixtureState) => {
  const ancestry = state.sync_ancestry;
  const base = ancestry?.base_manifest;
  return {
    schemaVersion: 9,
    collections: state.collections,
    ...catalogue(state),
    unmanaged: state.unmanaged.map(({ currentHash, lastHash, ...copy }) => ({
      ...copy,
      observedHash: currentHash,
      ...(lastHash === undefined ? {} : { lastObservedHash: lastHash }),
    })),
    global_bindings:
      state.enabled.length || state.invocation_policies !== undefined
        ? [{ ...binding(state.enabled), invocation_policies: state.invocation_policies }]
        : [],
    local_bindings: state.repositories.map((repository) => ({
      scope: { kind: "repository", root: repository.root },
      entries: entries(repository.enabled),
      invocation_policies: repository.invocation_policies,
    })),
    projections: state.installed_skills.map(
      ({ installed_skill_id, destination, installed_at, expected_hash, ...copy }) => ({
        ...copy,
        projection_id: installed_skill_id,
        target: destination,
        projected_at: installed_at,
        expected_digest: expected_hash,
        ...(copy.status === "conflicted" ? { observed_digest: copy.current_hash } : {}),
      }),
    ),
    ...(ancestry && base
      ? {
          sync_ancestry: {
            ...ancestry,
            base_manifest: {
              schema: "skit.library.v7",
              collections: base.collections,
              ...catalogue(base),
              snapshot_digests: base.snapshot_digests,
              bindings: base.enabled.length ? [binding(base.enabled)] : [],
            },
          },
        }
      : {}),
  };
};
