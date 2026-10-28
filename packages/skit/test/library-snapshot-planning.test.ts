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
import {
  importCanBeRefetched,
  librarySnapshotDigests,
  type Import,
  type LibraryManifest,
  type CollectionVersion,
} from "../src/library/library-contracts.js";
import { StoredLibraryManifest } from "../src/library/store/stored-manifest.js";

const digest = `sha256:${"a".repeat(64)}`;
const collectionVersionId = makeCollectionVersionId();
const machineId = makeMachineId();
const copy: CollectionVersion = {
  collection_version_id: collectionVersionId,
  hash: digest,
  copy_profile: "verbatim/v1",
  members: [
    {
      source_path: ".",
      source_hash: digest,
      artifact_hash: digest,
      materialization_profile: "plain-skill/v1",
    },
  ],
};
const collectionId = makeCollectionId();
const sourceImport = (overrides: Partial<Import>): Import => ({
  import_id: makeImportId(),
  collection_id: collectionId,
  kind: "source",
  collection_version_id: collectionVersionId,
  source_identity: {
    kind: "github",
    owner: "example-org",
    repository: "skills",
    collection_root: ".",
  },
  input: { value: "https://github.com/example-org/skills" },
  revision: "e0219e96214ac420bdb8d15141340625fda63bbb",
  imported_at: "2026-09-16T00:00:00.000Z",
  machine_id: machineId,
  lock_file_entries: [],
  ...overrides,
});

it("omits GitHub bytes pinned to a commit from private snapshot planning", () => {
  const pinned = sourceImport({});
  assert.strictEqual(importCanBeRefetched(pinned), true);
  assert.deepStrictEqual(
    librarySnapshotDigests({ collection_versions: [copy], imports: [pinned] }),
    [],
  );
});

it("restores by revision whatever the collection root or input text", () => {
  for (const restorable of [
    sourceImport({
      source_identity: {
        kind: "github",
        owner: "example-org",
        repository: "skills",
        collection_root: "skills",
      },
      input: { value: "https://github.com/example-org/skills/tree/main/skills" },
    }),
    sourceImport({
      source_identity: {
        kind: "registry",
        authority: "default",
        namespace: "tim",
        slug: "tools",
      },
      input: { value: "skit:tim/tools" },
      revision: "1.2.0",
    }),
  ])
    assert.strictEqual(importCanBeRefetched(restorable), true);
});

it("keeps unpinned, local, and edit imports snapshot-backed", () => {
  const { revision: _revision, ...unpinned } = sourceImport({});
  const local = sourceImport({
    source_identity: { kind: "local", machine_id: machineId, path: { value: "/tmp/skill" } },
    input: { value: "/tmp/skill" },
  });
  const edit = sourceImport({ kind: "edit" });
  for (const item of [unpinned, local, edit]) assert.strictEqual(importCanBeRefetched(item), false);
  assert.deepStrictEqual(
    librarySnapshotDigests({ collection_versions: [copy], imports: [unpinned] }),
    [digest],
  );
  assert.deepStrictEqual(
    librarySnapshotDigests({ collection_versions: [copy, { ...copy }], imports: [local] }),
    [digest],
  );
});

const sourceHash = `sha256:${"b".repeat(64)}`;
const sourceCopyId = makeCollectionVersionId();
const sourceCopy: CollectionVersion = {
  ...copy,
  collection_version_id: sourceCopyId,
  hash: sourceHash,
};
const { revision: _unpinnedRevision, ...unpinnedImport } = sourceImport({});
const mixedManifest: LibraryManifest = {
  schema: "skit.library.v8",
  collections: [{ collection_id: collectionId, label: "skills" }],
  skills: [],
  collection_versions: [copy, sourceCopy],
  imports: [unpinnedImport, sourceImport({ collection_version_id: sourceCopyId })],
  snapshot_digests: [digest],
  enabled: [],
};

it("decodes a v4 manifest into the current model without selections", () => {
  const skillId = makeSkillId();
  const versionId = makeSkillVersionId();
  const legacyImport = {
    acquisition_id: makeImportId(),
    retained_copy_id: collectionVersionId,
    source_identity: { kind: "url", url: { value: "https://skills.example#skills=review" } },
    tracking: { kind: "default" },
    selection: { kind: "full-tree" },
    input: { value: "wellknown:https://skills.example#skills=review" },
    acquired_at: "2026-09-16T00:00:00.000Z",
    machine_id: machineId,
    observations: [],
  };
  const decoded = Schema.decodeUnknownSync(StoredLibraryManifest)({
    schema: "skit.library.v4",
    collections: [{ collection_id: collectionId, display_name: "review" }],
    skills: [
      {
        skill_id: skillId,
        collection_id: collectionId,
        path: "review",
        name: "review",
        selected_skill_version_id: versionId,
        versions: [
          {
            skill_version_id: versionId,
            source_digest: digest,
            artifact_digest: digest,
            validation_identity_digest: digest,
            materialization_profile: "plain-skill/v1",
            origins: [{ acquisition_id: legacyImport.acquisition_id, source_path: "review" }],
          },
        ],
      },
    ],
    retained_copies: [
      {
        retained_copy_id: copy.collection_version_id,
        digest: copy.hash,
        copy_profile: copy.copy_profile,
        members: [
          {
            source_path: "review",
            source_digest: digest,
            artifact_digest: digest,
            materialization_profile: "plain-skill/v1",
          },
        ],
        v3_normalized_tree: {
          digest,
          profile: "legacy/v1",
          source_updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    acquisitions: [legacyImport],
    snapshot_digests: [digest],
    bindings: [],
  });
  assert.strictEqual(decoded.schema, "skit.library.v8");
  assert.strictEqual("v3_normalized_tree" in decoded.collection_versions[0]!, false);
  assert.deepStrictEqual(decoded.imports[0]?.source_identity, {
    kind: "well-known",
    locator: { value: "https://skills.example" },
  });
  assert.strictEqual(decoded.imports[0]?.kind, "source");
  assert.strictEqual(decoded.imports[0]?.collection_id, collectionId);
  assert.deepStrictEqual(decoded.skills[0]?.versions[0]?.skill_version_id, versionId);
});

it("rejects a Skill Version that no import of its Collection backs", () => {
  const versionId = makeSkillVersionId();
  const otherHash = `sha256:${"c".repeat(64)}`;
  assert.throws(() =>
    Schema.decodeUnknownSync(StoredLibraryManifest)({
      ...mixedManifest,
      skills: [
        {
          skill_id: makeSkillId(),
          collection_id: collectionId,
          path: ".",
          name: "review",
          versions: [
            {
              skill_version_id: versionId,
              source_digest: otherHash,
              artifact_digest: otherHash,
              validation_identity_digest: otherHash,
              materialization_profile: "plain-skill/v1",
            },
          ],
        },
      ],
    }),
  );
});
