import { assert } from "@effect/vitest";
import type { LibraryState } from "../../src/library/library-state.js";
import type { Enabled } from "../../src/library/library-contracts.js";

const bindingEntries = (enabled: readonly Enabled[]) =>
  enabled.map((item) =>
    "skill" in item
      ? { kind: "skill", skill_id: item.skill }
      : { kind: "collection", collection_id: item.collection },
  );

/** A current state written as the v9 document it migrates from, so tests can build older states. */
export const asV9 = ({
  schemaVersion: _schemaVersion,
  collection_versions,
  imports,
  enabled,
  invocation_policies,
  repositories,
  installed_skills,
  skills,
  ...fields
}: LibraryState) => {
  assert.isUndefined(fields.sync_ancestry);
  assert.isUndefined(fields.device_skill_selection);
  assert.isUndefined(fields.ownershipIssues);
  return {
    ...fields,
    schemaVersion: 9,
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
    retained_copies: collection_versions.map(
      ({ collection_version_id, hash, members, ...copy }) => ({
        ...copy,
        retained_copy_id: collection_version_id,
        digest: hash,
        members: members.map(({ source_hash, artifact_hash, ...member }) => ({
          ...member,
          source_digest: source_hash,
          artifact_digest: artifact_hash,
        })),
      }),
    ),
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
    global_bindings:
      enabled.length > 0 || invocation_policies !== undefined
        ? [
            {
              scope: { kind: "global" },
              entries: bindingEntries(enabled),
              ...(invocation_policies === undefined ? {} : { invocation_policies }),
            },
          ]
        : [],
    local_bindings: repositories.map((repository) => ({
      scope: { kind: "repository", root: repository.root },
      entries: bindingEntries(repository.enabled),
      ...(repository.invocation_policies === undefined
        ? {}
        : { invocation_policies: repository.invocation_policies }),
    })),
    projections: installed_skills.map(
      ({ installed_skill_id, destination, installed_at, expected_hash, ...copy }) => ({
        ...copy,
        projection_id: installed_skill_id,
        target: destination,
        projected_at: installed_at,
        expected_digest: expected_hash,
        ...(copy.status === "conflicted" ? { observed_digest: copy.current_hash } : {}),
      }),
    ),
  };
};
