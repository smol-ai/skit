import { Effect, Schema } from "effect";
import { Hash } from "../../src/shared/hash.js";
import {
  makeCollectionId,
  makeCollectionVersionId,
  makeImportId,
  makeInstalledSkillId,
  makeMachineId,
  makeSkillId,
  makeSkillVersionId,
} from "../../src/library/entity-ids.js";
import {
  decodeLibraryState,
  emptyLibraryState,
  libraryManifestFromLocalState,
} from "../../src/library/library-state.js";

export const fixture = Effect.gen(function* () {
  const collections = Array.from({ length: 32 }, (_, index) => ({
    collection_id: makeCollectionId(),
    label: "collection-" + index,
    extension: { ordered: [3, 2, 1], absent: null },
  }));
  const skills = Array.from({ length: 298 }, (_, index) => ({
    skill_id: makeSkillId(),
    collection_id: collections[index % collections.length]?.collection_id,
    path: "skill-" + index,
    name: "skill-" + index,
    versions: [
      {
        skill_version_id: makeSkillVersionId(),
        source_hash: "sha256:" + (index + 1).toString(16).padStart(64, "0"),
        artifact_hash: "sha256:" + (index + 1).toString(16).padStart(64, "0"),
        validation_identity_hash: "sha256:" + (index + 1).toString(16).padStart(64, "0"),
        materialization_profile: "plain-skill/v1",
        extension: { bytes: "old", nested: [null, false, {}] },
      },
    ],
    extension: { ["__proto__"]: { retained: true }, nested: [1, "two"] },
  }));
  const collectionVersions = collections.map((collection, index) => ({
    collection_version_id: makeCollectionVersionId(),
    hash: "sha256:" + (index + 1000).toString(16).padStart(64, "0"),
    copy_profile: "verbatim/v1",
    members: skills
      .filter((skill) => skill.collection_id === collection.collection_id)
      .map((skill) => ({
        source_path: skill.path,
        source_hash: skill.versions[0]?.source_hash,
        artifact_hash: skill.versions[0]?.artifact_hash,
        materialization_profile: "plain-skill/v1",
        extension: { original: ["member", null] },
      })),
  }));
  const machine = makeMachineId();
  const imports = collections.map((collection, index) => ({
    import_id: makeImportId(),
    collection_id: collection.collection_id,
    kind: "source",
    collection_version_id: collectionVersions[index]?.collection_version_id,
    source_identity: { kind: "local", machine_id: machine, path: { value: "/source/" + index } },
    input: { value: "/source/" + index, extension: { original: true } },
    imported_at: "2026-11-01T00:00:00.000Z",
    machine_id: machine,
    lock_file_entries: [],
  }));
  const futureVersions = Array.from({ length: 4 }, (_, index) => ({
    skill_version_id: makeSkillVersionId(),
    source_hash: "sha256:" + (index + 2000).toString(16).padStart(64, "0"),
    artifact_hash: "sha256:" + (index + 2000).toString(16).padStart(64, "0"),
    validation_identity_hash: "sha256:" + (index + 2000).toString(16).padStart(64, "0"),
    materialization_profile: "plain-skill/v1",
    extension: { bytes: "new", nested: [null, true, []] },
  }));
  for (const [index, version] of futureVersions.entries()) {
    const skill = skills[index];
    if (!skill) continue;
    const copy = {
      collection_version_id: makeCollectionVersionId(),
      hash: "sha256:" + (index + 3000).toString(16).padStart(64, "0"),
      copy_profile: "verbatim/v1",
      members: [
        {
          source_path: ".",
          source_hash: version.source_hash,
          artifact_hash: version.artifact_hash,
          materialization_profile: version.materialization_profile,
          extension: { original: ["member", null] },
        },
      ],
    };
    collectionVersions.push(copy);
    imports.push({
      import_id: makeImportId(),
      collection_id: skill.collection_id,
      kind: "edit",
      collection_version_id: copy.collection_version_id,
      source_identity: { kind: "local", machine_id: machine, path: { value: "/edit/" + index } },
      input: { value: "/edit/" + index, extension: { original: true } },
      imported_at: "2026-11-02T00:00:00.000Z",
      machine_id: machine,
      lock_file_entries: [],
    });
    // The first edit is retained but not yet a Skill Version: adding it needs no new backing.
    if (index > 0) skill.versions.push(version);
  }
  for (const source of imports.slice(0, 4))
    imports.push({ ...source, import_id: makeImportId(), imported_at: "2026-11-03T00:00:00.000Z" });
  const first = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      skill_id: Schema.String,
      versions: Schema.Array(Schema.Struct({ skill_version_id: Schema.String, source_hash: Hash })),
    }),
  )(skills[0]);
  const issue = { path: "/observed", harness: "codex", code: "UNREADABLE_PATH", extension: [1, 1] };
  const acceptance = {
    fingerprint: "sha256:" + "a".repeat(64),
    artifactContentHash: first.versions[0]?.source_hash,
    skill_version_id: first.versions[0]?.skill_version_id,
    context: "project",
    principal: "test",
    rationale: "reviewed",
    acceptedAt: "2026-11-01T00:00:00.000Z",
    extension: { kept: null },
  };
  const state = yield* decodeLibraryState({
    ...emptyLibraryState(),
    collections,
    skills,
    imports,
    collection_versions: collectionVersions,
    installed_skills: skills.slice(0, 8).map((skill, index) => ({
      installed_skill_id: makeInstalledSkillId(),
      skill_id: skill.skill_id,
      skill_version_id: skill.versions[0]?.skill_version_id,
      destination: "agents",
      root: "/device/skills",
      path: "/device/skills/" + index,
      expected_hash: skill.versions[0]?.source_hash,
      installed_at: "2026-11-04T00:00:00.000Z",
      status: "installed",
      extension: { previous: [null, "bytes"] },
    })),
    repositories: [
      {
        root: "/repo",
        enabled: [{ skill: first.skill_id }],
        invocation_policies: { [first.skill_id]: "explicit" },
        extension: { retained: true },
      },
    ],
    invocation_policies: { [first.skill_id]: "implicit" },
    device_skill_selection: { mode: "choose", enabled: [], extension: { original: null } },
    pending_device_selection_origin: "https://registry.example",
    unmanaged: [0, 1].map(() => ({
      harness: "codex",
      harnesses: ["codex"],
      path: '/unmanaged/quoted:"\n雪',
      paths: ["/unmanaged/alias", "/unmanaged/alias"],
      currentHash: first.versions[0]?.source_hash,
      extension: { kept: [false, false] },
    })),
    ownershipIssues: [
      {
        code: "ORPHANED_OWNERSHIP_MARKER",
        path: "/orphan",
        canonicalPath: "/orphan",
        harnesses: ["codex"],
        currentHash: first.versions[0]?.source_hash,
        installedSkillId: makeInstalledSkillId(),
        skillId: makeSkillId(),
      },
    ],
    scanIssues: [issue, issue],
    assessmentAcceptances: [acceptance, acceptance],
    ["__proto__"]: { extension: [null, {}, [], ""] },
    "unknown/field:雪": { nested: { empty: [], missing: null } },
  });
  const manifest = yield* libraryManifestFromLocalState(state);
  const full = yield* decodeLibraryState({
    ...state,
    sync_ancestry: {
      origin: "https://registry.example",
      library_id: "fixture",
      revision_id: "accepted-remote",
      base_manifest: { ...manifest, extension: { original: ["remote", null] } },
      extension: { receipt: true },
    },
  });
  return { state: full, future: futureVersions[0] };
});
