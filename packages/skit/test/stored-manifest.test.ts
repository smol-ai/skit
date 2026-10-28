import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  makeImportId,
  makeCollectionId,
  makeMachineId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { LibraryManifest } from "../src/library/library-contracts.js";
import { StoredLibraryManifest } from "../src/library/store/stored-manifest.js";

const hash = `sha256:${"a".repeat(64)}`;
const collectionId = makeCollectionId();
const skillId = makeSkillId();
const otherSkillId = makeSkillId();
const versionId = makeSkillVersionId();
const otherVersionId = makeSkillVersionId();
const importId = makeImportId();
const collectionVersionId = makeCollectionVersionId();
const machineId = makeMachineId();
const sourceIdentity = {
  kind: "registry" as const,
  authority: "registry.test",
  namespace: "test",
  slug: "library",
};
const collectionVersion = {
  retained_copy_id: collectionVersionId,
  digest: hash,
  copy_profile: "verbatim/v1",
  members: ["review", "lint"].map((source_path) => ({
    source_path,
    source_digest: hash,
    artifact_digest: hash,
    materialization_profile: "plain-skill/v1",
  })),
};
const version = (skill_version_id: string) => ({
  skill_version_id,
  source_digest: hash,
  artifact_digest: hash,
  validation_identity_digest: hash,
  materialization_profile: "plain-skill/v1",
});

it("migrates a v5 manifest through v6 to the current model", () => {
  const decoded = Schema.decodeUnknownSync(StoredLibraryManifest)({
    schema: "skit.library.v5",
    collections: [
      {
        collection_id: collectionId,
        label: "test/library",
        upstream: {
          source_identity: sourceIdentity,
          tracking: { kind: "default" },
          selection: { kind: "full-tree" },
          last_acquisition_id: importId,
        },
      },
    ],
    skills: [
      [skillId, versionId, "review"],
      [otherSkillId, otherVersionId, "lint"],
    ].map(([skill_id, skill_version_id, name]) => ({
      skill_id,
      collection_id: collectionId,
      path: name,
      name,
      selected_skill_version_id: skill_version_id,
      versions: [
        {
          ...version(skill_version_id!),
          origins: [{ acquisition_id: importId, source_path: name }],
        },
      ],
    })),
    retained_copies: [collectionVersion],
    acquisitions: [
      {
        acquisition_id: importId,
        retained_copy_id: collectionVersionId,
        source_identity: sourceIdentity,
        tracking: { kind: "default" },
        selection: { kind: "full-tree" },
        input: { value: "private:test/library@1.2.0" },
        acquired_at: "2026-09-20T00:00:00.000Z",
        machine_id: machineId,
        observations: [],
      },
    ],
    snapshot_digests: [hash],
    bindings: [
      { harness: "codex", scope: { kind: "global" }, skills: [skillId, otherSkillId] },
      { harness: "claude-code", scope: { kind: "global" }, skills: [skillId] },
    ],
  });

  assert.strictEqual(decoded.schema, "skit.library.v8");
  assert.deepStrictEqual(decoded.collections, [
    {
      collection_id: collectionId,
      label: "test/library",
      upstream: { source_identity: sourceIdentity, tracking: { kind: "default" } },
    },
  ]);
  assert.deepStrictEqual(
    decoded.imports.map(({ collection_id, kind, revision }) => ({
      collection_id,
      kind,
      revision,
    })),
    [{ collection_id: collectionId, kind: "source", revision: "1.2.0" }],
  );
  assert.deepStrictEqual(
    decoded.skills.map((skill) => [skill.skill_id, skill.versions.map((v) => v.skill_version_id)]),
    [
      [skillId, [versionId]],
      [otherSkillId, [otherVersionId]],
    ],
  );
  // A pinned Registry Release restores from its Source, so no private snapshot is required.
  assert.deepStrictEqual(decoded.snapshot_digests, []);
  // Codex bound the whole Collection, which covers Claude Code's single Skill.
  assert.deepStrictEqual(decoded.enabled, [{ collection: collectionId }]);
});

it("merges a v6 manifest's per-Harness Bindings into one global Binding", () => {
  const decoded = Schema.decodeUnknownSync(StoredLibraryManifest)({
    schema: "skit.library.v6",
    collections: [{ collection_id: collectionId, label: "test/library" }],
    skills: [
      {
        skill_id: skillId,
        collection_id: collectionId,
        path: "review",
        name: "review",
        versions: [version(versionId)],
      },
    ],
    retained_copies: [{ ...collectionVersion, members: [collectionVersion.members[0]] }],
    acquisitions: [
      {
        acquisition_id: importId,
        collection_id: collectionId,
        kind: "source",
        retained_copy_id: collectionVersionId,
        source_identity: { kind: "local", machine_id: machineId, path: { value: "/tmp/library" } },
        input: { value: "/tmp/library" },
        acquired_at: "2026-09-20T00:00:00.000Z",
        machine_id: machineId,
        observations: [],
      },
    ],
    snapshot_digests: [hash],
    bindings: [
      {
        harness: "codex",
        scope: { kind: "global" },
        entries: [{ kind: "collection", collection_id: collectionId }],
      },
      {
        harness: "claude-code",
        scope: { kind: "global" },
        entries: [{ kind: "skill", skill_id: skillId }],
      },
    ],
  });

  assert.strictEqual(decoded.schema, "skit.library.v8");
  // The Skill entry is covered by its whole-Collection entry, so only the Collection remains.
  assert.deepStrictEqual(decoded.enabled, [{ collection: collectionId }]);
});

it("encodes a migrated manifest as the current model only", () => {
  const decoded = Schema.decodeUnknownSync(StoredLibraryManifest)({
    schema: "skit.library.v6",
    collections: [],
    skills: [],
    retained_copies: [],
    acquisitions: [],
    snapshot_digests: [],
    bindings: [],
  });
  assert.deepStrictEqual(Schema.encodeSync(LibraryManifest)(decoded), {
    schema: "skit.library.v8",
    collections: [],
    skills: [],
    collection_versions: [],
    imports: [],
    snapshot_digests: [],
    enabled: [],
  });
});

it("migrates a v7 manifest to plain names and a list of enabled items", () => {
  const editId = makeImportId();
  const decoded = Schema.decodeUnknownSync(StoredLibraryManifest)({
    schema: "skit.library.v7",
    collections: [{ collection_id: collectionId, label: "test/library" }],
    skills: [
      {
        skill_id: skillId,
        collection_id: collectionId,
        path: "review",
        name: "review",
        versions: [version(versionId)],
      },
    ],
    retained_copies: [{ ...collectionVersion, members: [collectionVersion.members[0]] }],
    acquisitions: [
      {
        acquisition_id: importId,
        collection_id: collectionId,
        kind: "source",
        retained_copy_id: collectionVersionId,
        source_identity: { kind: "local", machine_id: machineId, path: { value: "/tmp/library" } },
        input: { value: "/tmp/library" },
        acquired_at: "2026-09-20T00:00:00.000Z",
        machine_id: machineId,
        observations: [],
      },
      {
        acquisition_id: editId,
        collection_id: collectionId,
        kind: "retained-edit",
        retained_copy_id: collectionVersionId,
        source_identity: { kind: "local", machine_id: machineId, path: { value: "/tmp/library" } },
        input: { value: "/tmp/edit" },
        acquired_at: "2026-09-21T00:00:00.000Z",
        machine_id: machineId,
        observations: [],
      },
    ],
    snapshot_digests: [hash],
    bindings: [
      {
        scope: { kind: "global" },
        entries: [
          { kind: "collection", collection_id: collectionId },
          { kind: "skill", skill_id: skillId },
        ],
      },
    ],
  });

  assert.strictEqual(decoded.schema, "skit.library.v8");
  assert.deepStrictEqual(
    decoded.collection_versions.map((item) => item.collection_version_id),
    [collectionVersionId],
  );
  assert.deepStrictEqual(
    decoded.imports.map((item) => [
      item.import_id,
      item.kind,
      item.collection_version_id,
      item.imported_at,
      item.lock_file_entries,
    ]),
    [
      [importId, "source", collectionVersionId, "2026-09-20T00:00:00.000Z", []],
      [editId, "edit", collectionVersionId, "2026-09-21T00:00:00.000Z", []],
    ],
  );
  assert.deepStrictEqual(decoded.enabled, [{ collection: collectionId }, { skill: skillId }]);
});
