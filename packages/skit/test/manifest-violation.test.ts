import { expect, test } from "vitest";
import { Result, Schema } from "effect";
import {
  LibraryManifest,
  currentLibraryManifest,
  librarySnapshotDigests,
} from "../src/library/library-contracts.js";
import { ManifestViolation } from "../src/library/manifest-violation.js";
import { SchemaFailure } from "../src/shared/schema-issue.js";
import { Hash } from "../src/shared/hash.js";
import { SyncAncestry as SyncAncestryV11 } from "../src/library/store/state-records-v11.js";
import {
  makeCollectionId,
  makeCollectionVersionId,
  makeImportId,
  makeMachineId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";

const hash = Hash.make(`sha256:${"a".repeat(64)}`);
const otherHash = Hash.make(`sha256:${"b".repeat(64)}`);
const collectionId = makeCollectionId();
const skillId = makeSkillId();
const copyId = makeCollectionVersionId();
const importId = makeImportId();
const versionId = makeSkillVersionId();
const missingCollection = makeCollectionId();
const missingCopy = makeCollectionVersionId();
const missingVersion = makeSkillVersionId();
const missingSkill = makeSkillId();
const identity = {
  kind: "github" as const,
  owner: "fixture",
  repository: "tools",
  collection_root: ".",
};
const member = {
  source_path: "review",
  source_hash: hash,
  artifact_hash: hash,
  materialization_profile: "plain-skill/v1" as const,
};
const version = {
  skill_version_id: versionId,
  source_hash: hash,
  artifact_hash: hash,
  validation_identity_hash: hash,
  materialization_profile: "plain-skill/v1" as const,
};
const draft = currentLibraryManifest({
  collections: [{ collection_id: collectionId, label: "fixture/tools" }],
  skills: [
    {
      skill_id: skillId,
      collection_id: collectionId,
      path: "review",
      name: "review",
      versions: [version],
    },
  ],
  collection_versions: [
    { collection_version_id: copyId, hash, copy_profile: "verbatim/v1", members: [member] },
  ],
  imports: [
    {
      import_id: importId,
      collection_id: collectionId,
      kind: "source",
      collection_version_id: copyId,
      source_identity: identity,
      input: { value: "github:fixture/tools" },
      revision: "a".repeat(40),
      imported_at: "2026-01-01T00:00:00.000Z",
      machine_id: makeMachineId(),
      lock_file_entries: [],
    },
  ],
  snapshot_digests: [],
  enabled: [{ collection: collectionId }],
});
const base = Schema.decodeSync(LibraryManifest)({
  ...draft,
  snapshot_digests: librarySnapshotDigests(draft),
});
const collection = { collectionId, label: "fixture/tools" };
const skill = { skillId, name: "review" };
const secondSkill = {
  skill_id: makeSkillId(),
  collection_id: collectionId,
  path: "lint",
  name: "lint",
  versions: [],
};
const extraVersionId = makeSkillVersionId();
const secondCollectionId = makeCollectionId();

const cases: readonly {
  name: string;
  change: (manifest: LibraryManifest) => LibraryManifest;
  expected: ManifestViolation;
}[] = [
  {
    name: "duplicate collection IDs",
    change: (m) => ({ ...m, collections: [...m.collections, m.collections[0]!] }),
    expected: { _tag: "DuplicateIdentifiers", entity: "collections", ids: [collectionId] },
  },
  {
    name: "duplicate skill paths",
    change: (m) => ({ ...m, skills: [...m.skills, { ...secondSkill, path: "review" }] }),
    expected: { _tag: "DuplicateSkillPaths", ...collection, paths: ["review"] },
  },
  {
    name: "duplicate current names",
    change: (m) => ({
      ...m,
      skills: [...m.skills, { ...secondSkill, name: "review" }],
      collection_versions: [
        { ...m.collection_versions[0]!, members: [member, { ...member, source_path: "lint" }] },
      ],
    }),
    expected: { _tag: "DuplicateSkillNames", ...collection, names: ["review"] },
  },
  {
    name: "overlapping paths",
    change: (m) => ({ ...m, skills: [...m.skills, { ...secondSkill, path: "review/child" }] }),
    expected: {
      _tag: "OverlappingSkillPaths",
      ...collection,
      left: "review",
      right: "review/child",
    },
  },
  {
    name: "root mixed with children",
    change: (m) => ({ ...m, skills: [...m.skills, { ...secondSkill, path: "." }] }),
    expected: { _tag: "RootSkillWithChildren", ...collection, paths: ["review", "."] },
  },
  {
    name: "duplicate upstream",
    change: (m) => ({
      ...m,
      collections: [
        {
          ...m.collections[0]!,
          upstream: { source_identity: identity, tracking: { kind: "default" } },
        },
        {
          collection_id: secondCollectionId,
          label: "other/tools",
          upstream: { source_identity: identity, tracking: { kind: "default" } },
        },
      ],
    }),
    expected: {
      _tag: "DuplicateUpstream",
      first: collection,
      second: { collectionId: secondCollectionId, label: "other/tools" },
    },
  },
  {
    name: "missing import collection",
    change: (m) => ({ ...m, imports: [{ ...m.imports[0]!, collection_id: missingCollection }] }),
    expected: { _tag: "ImportCollectionMissing", importId, collectionId: missingCollection },
  },
  {
    name: "missing import copy",
    change: (m) => ({ ...m, imports: [{ ...m.imports[0]!, collection_version_id: missingCopy }] }),
    expected: { _tag: "ImportCopyMissing", importId, copyId: missingCopy },
  },
  {
    name: "empty copy",
    change: (m) => ({ ...m, collection_versions: [{ ...m.collection_versions[0]!, members: [] }] }),
    expected: { _tag: "CopyMembersEmpty", copyId },
  },
  {
    name: "duplicate copy member paths",
    change: (m) => ({
      ...m,
      collection_versions: [{ ...m.collection_versions[0]!, members: [member, member] }],
    }),
    expected: { _tag: "CopyMemberPathsDuplicate", copyId, paths: ["review"] },
  },
  {
    name: "copy without import",
    change: (m) => ({ ...m, imports: [] }),
    expected: { _tag: "CopyImportMissing", copyId },
  },
  {
    name: "missing skill collection",
    change: (m) => ({ ...m, skills: [{ ...m.skills[0]!, collection_id: missingCollection }] }),
    expected: { _tag: "SkillCollectionMissing", ...skill, collectionId: missingCollection },
  },
  {
    name: "missing selected version",
    change: (m) => ({ ...m, skills: [{ ...m.skills[0]!, local_version_id: missingVersion }] }),
    expected: { _tag: "SkillVersionMissing", ...skill, versionId: missingVersion },
  },
  {
    name: "multiple versions for an artifact",
    change: (m) => ({
      ...m,
      skills: [
        { ...m.skills[0]!, versions: [version, { ...version, skill_version_id: extraVersionId }] },
      ],
    }),
    expected: {
      _tag: "ArtifactVersionsDuplicate",
      ...skill,
      hash,
      versionIds: [versionId, extraVersionId],
    },
  },
  {
    name: "version without retained backing",
    change: (m) => ({
      ...m,
      skills: [{ ...m.skills[0]!, versions: [{ ...version, source_hash: otherHash }] }],
    }),
    expected: { _tag: "VersionBackingMissing", ...skill, versionId },
  },
  {
    name: "duplicate snapshot digests",
    change: (m) => ({ ...m, snapshot_digests: [hash, hash] }),
    expected: { _tag: "CollectionVersionHashesDuplicate", digests: [hash, hash] },
  },
  {
    name: "snapshot digest mismatch",
    change: (m) => ({ ...m, snapshot_digests: [...m.snapshot_digests, otherHash] }),
    expected: {
      _tag: "CollectionVersionHashesMismatch",
      expected: base.snapshot_digests,
      actual: [...base.snapshot_digests, otherHash],
    },
  },
  {
    name: "duplicate enabled item",
    change: (m) => ({ ...m, enabled: [...m.enabled, ...m.enabled] }),
    expected: { _tag: "EnabledDuplicate", kind: "collection", id: collectionId },
  },
  {
    name: "missing enabled subject",
    change: (m) => ({ ...m, enabled: [{ skill: missingSkill }] }),
    expected: { _tag: "EnabledSubjectMissing", kind: "skill", id: missingSkill },
  },
  {
    name: "missing enabled subject before a later duplicate",
    change: (m) => ({ ...m, enabled: [{ skill: missingSkill }, ...m.enabled, ...m.enabled] }),
    expected: { _tag: "EnabledSubjectMissing", kind: "skill", id: missingSkill },
  },
  {
    name: "duplicate enabled item before a later missing subject",
    change: (m) => ({ ...m, enabled: [...m.enabled, ...m.enabled, { skill: missingSkill }] }),
    expected: { _tag: "EnabledDuplicate", kind: "collection", id: collectionId },
  },
];

for (const [version, manifest] of [
  ["current", LibraryManifest],
  ["v11", SyncAncestryV11.fields.base_manifest],
] as const) {
  test.each(cases)(
    `${version} retains $name as domain facts through native Schema and JSON`,
    ({ change, expected }) => {
      const result = Schema.decodeResult(manifest)(change(base));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) throw new Error("Invalid manifest accepted");
      const wire = Schema.encodeSync(Schema.toCodecJson(SchemaFailure))(result.failure);
      const stored = Schema.decodeUnknownSync(SchemaFailure)(JSON.parse(JSON.stringify(wire)));
      if (stored._tag !== "StoredSchemaFailure") throw new Error("Missing stored facts");
      const issue = stored.issues.find(
        (issue) =>
          issue.reason._tag === "InvalidValue" &&
          issue.reason.check?.id === "skit/schema/library-manifest",
      );
      expect(issue).toBeDefined();
      if (issue?.reason._tag !== "InvalidValue") throw new Error("Missing manifest violation");
      expect(Schema.decodeUnknownSync(ManifestViolation)(issue.reason.check?.payload)).toEqual(
        expected,
      );
      expect(JSON.stringify(wire)).not.toContain('"message"');
    },
  );
}
