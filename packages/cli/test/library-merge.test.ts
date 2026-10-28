import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  currentCollectionSkills,
  currentSkillVersion,
  sourceImports,
  makeImportId,
  makeCollectionId,
  makeMachineId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
  LibraryManifest,
  LibraryState,
  makeInstalledSkillId,
  strandedByRestore,
} from "@smolai/skit-core";
import {
  normalizeLibraryManifest,
  mergeLibraryManifests,
  prepareLibraryMerge,
} from "../src/workflows/library/library-merge.js";
import { planLibrarySync } from "../src/workflows/library/library-sync-plan.js";

import { alignLibrary, aliasManifest } from "../src/workflows/library/library-alignment.js";

const digest = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const decode = Schema.decodeUnknownEffect(LibraryManifest);
const skillId = makeSkillId();
const versionId = makeSkillVersionId();
const collectionId = makeCollectionId();
const acquisitionId = makeImportId();
const retainedCopyId = makeCollectionVersionId();
const machineId = makeMachineId();
const second = makeSkillVersionId();
const third = makeSkillVersionId();
const acquisitionB = makeImportId();
const acquisitionC = makeImportId();
const copyB = makeCollectionVersionId();
const copyC = makeCollectionVersionId();
const collection = {
  collection_id: collectionId,
  label: "fixture/skills",
};
const skill = {
  skill_id: skillId,
  collection_id: collectionId,
  path: "." as const,
  name: "review",
  versions: [
    {
      skill_version_id: versionId,
      source_digest: digest,
      artifact_digest: digest,
      validation_identity_digest: digest,
      materialization_profile: "plain-skill/v1" as const,
    },
    {
      skill_version_id: second,
      source_digest: digestB,
      artifact_digest: digestB,
      validation_identity_digest: digestB,
      materialization_profile: "plain-skill/v1" as const,
    },
    {
      skill_version_id: third,
      source_digest: digestC,
      artifact_digest: digestC,
      validation_identity_digest: digestC,
      materialization_profile: "plain-skill/v1" as const,
    },
  ],
};
const manifest = (enabled: unknown[] = []) => ({
  schema: "skit.library.v8",
  collections: [collection],
  skills: [skill],
  collection_versions: [
    {
      collection_version_id: retainedCopyId,
      digest,
      copy_profile: "verbatim/v1" as const,
      members: [
        {
          source_path: "." as const,
          source_digest: digest,
          artifact_digest: digest,
          materialization_profile: "plain-skill/v1" as const,
        },
      ],
    },
    ...[
      [copyB, digestB],
      [copyC, digestC],
    ].map(([collection_version_id, value]) => ({
      collection_version_id,
      digest: value,
      copy_profile: "verbatim/v1" as const,
      members: [
        {
          source_path: "." as const,
          source_digest: value,
          artifact_digest: value,
          materialization_profile: "plain-skill/v1" as const,
        },
      ],
    })),
  ],
  imports: [
    {
      import_id: acquisitionId,
      collection_id: collectionId,
      kind: "source" as const,
      collection_version_id: retainedCopyId,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: "/tmp/fixture" },
      },
      input: { value: "/tmp/fixture" },
      imported_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      lock_file_entries: [],
    },
    ...[
      [acquisitionB, copyB],
      [acquisitionC, copyC],
    ].map(([import_id, collection_version_id]) => ({
      import_id,
      collection_id: collectionId,
      // Later Versions are retained local edits, so the Source keeps observing the first.
      kind: "edit" as const,
      collection_version_id,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: "/tmp/fixture" },
      },
      input: { value: "/tmp/fixture" },
      imported_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      lock_file_entries: [],
    })),
  ],
  snapshot_digests: [digest, digestB, digestC],
  enabled,
});

it.effect(
  "independent Collection membership differences conflict even when shared content matches",
  () =>
    Effect.gen(function* () {
      const remote = yield* decode({
        ...manifest(),
        skills: [{ ...skill, path: "one" }],
        collection_versions: manifest().collection_versions.map((item) =>
          item.collection_version_id === retainedCopyId
            ? {
                ...item,
                members: item.members.map((member) => ({ ...member, source_path: "one" })),
              }
            : item,
        ),
      });
      const extra = makeSkillId();
      const copy = makeCollectionVersionId();
      const latestDigest = `sha256:${"d".repeat(64)}`;
      const local = yield* decode({
        ...remote,
        skills: [
          ...remote.skills,
          {
            ...skill,
            skill_id: extra,
            name: "extra",
            path: "extra",
            versions: [{ ...skill.versions[0], skill_version_id: makeSkillVersionId() }],
          },
        ],
        collection_versions: [
          ...remote.collection_versions,
          {
            ...manifest().collection_versions[0],
            collection_version_id: copy,
            digest: latestDigest,
            members: [
              ...remote.collection_versions[0].members,
              { ...manifest().collection_versions[0].members[0], source_path: "extra" },
            ],
          },
        ],
        imports: [
          ...manifest().imports,
          {
            ...manifest().imports[0],
            import_id: makeImportId(),
            collection_version_id: copy,
            imported_at: "2026-02-01T00:00:00Z",
          },
        ],
        snapshot_digests: [...manifest().snapshot_digests, latestDigest],
      });
      const empty = yield* decode({
        schema: "skit.library.v8",
        collections: [],
        skills: [],
        imports: [],
        collection_versions: [],
        snapshot_digests: [],
        enabled: [],
      });
      const merged = mergeLibraryManifests(empty, local, remote, new Set(), [], [collectionId]);
      assert.deepEqual(merged.conflicts, [`collection:${collectionId}`]);
      assert.deepEqual(merged.unresolvable, [`collection:${collectionId}`]);
      const pinned = yield* decode({
        ...local,
        snapshot_digests: local.snapshot_digests.filter((value) => value !== latestDigest),
        imports: local.imports.map((item) =>
          item.collection_version_id === copy
            ? {
                ...item,
                source_identity: {
                  kind: "github",
                  owner: "fixture",
                  repository: "skills",
                  collection_root: ".",
                },
                revision: "b".repeat(40),
              }
            : item,
        ),
      });
      const chosen = mergeLibraryManifests(
        empty,
        pinned,
        remote,
        new Set([`collection:${collectionId}`]),
        [],
        [collectionId],
      );
      assert.deepEqual(chosen.conflicts, []);
      assert.deepEqual(chosen.unresolvable, []);
      assert.isFalse(chosen.manifest.skills.some((item) => item.skill_id === extra));
      assert.isFalse(chosen.manifest.imports.some((item) => item.collection_version_id === copy));
      yield* decode(chosen.manifest);
    }).pipe(Effect.scoped),
);

it.effect("independent Collection remote choice cannot discard a selected local edit", () =>
  Effect.gen(function* () {
    const remote = yield* decode(manifest());
    const local = yield* decode({
      ...manifest(),
      skills: [{ ...skill, local_version_id: second }],
    });
    const empty = yield* decode({
      schema: "skit.library.v8",
      collections: [],
      skills: [],
      imports: [],
      collection_versions: [],
      snapshot_digests: [],
      enabled: [],
    });
    const key = `collection:${collectionId}`;
    const merged = mergeLibraryManifests(empty, local, remote, new Set([key]), [skillId]);
    assert.deepEqual(merged.conflicts, [key]);
    assert.deepEqual(merged.unresolvable, [key]);
  }).pipe(Effect.scoped),
);

it.effect("resolves Collection deletion against a new import as one conflict", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const removed = yield* decode({
      ...manifest(),
      collections: [],
      skills: [],
      imports: [],
      collection_versions: [],
      snapshot_digests: [],
    });
    const refreshed = yield* decode({
      ...manifest(),
      imports: [
        ...manifest().imports,
        {
          ...manifest().imports[0],
          import_id: makeImportId(),
          imported_at: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    for (const [local, remote] of [
      [removed, refreshed],
      [refreshed, removed],
    ]) {
      const key = `collection:${collectionId}`;
      assert.deepEqual(mergeLibraryManifests(base, local, remote).conflicts, [key]);
      const resolved = mergeLibraryManifests(base, local, remote, new Set([key]));
      assert.deepEqual(resolved.conflicts, []);
      yield* LibraryManifest.makeEffect(resolved.manifest);
      assert.deepEqual(resolved.manifest.collections, remote.collections);
      assert.deepEqual(resolved.manifest.imports, remote.imports);
      assert.deepEqual(resolved.manifest.skills, remote.skills);
    }
  }),
);

it.effect("merges an independently added global Binding", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const local = yield* decode(manifest([{ skill: skillId }]));
    const merged = mergeLibraryManifests(base, local, base);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.manifest.enabled, local.enabled);
  }),
);

it.effect("reports concurrent retained-edit selections without choosing a winner", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const select = (id: typeof versionId) => ({
      ...manifest(),
      skills: [{ ...skill, local_version_id: id }],
    });
    const local = yield* decode(select(second));
    const remote = yield* decode(select(third));
    const conflicted = mergeLibraryManifests(base, local, remote);
    assert.deepEqual(conflicted.conflicts, [`skill:${skillId}`]);
    const accepted = mergeLibraryManifests(base, local, remote, new Set([`skill:${skillId}`]));
    assert.deepEqual(accepted.conflicts, []);
    assert.strictEqual(accepted.manifest.skills[0]?.local_version_id, third);
  }),
);

it.effect("plans destination-specific Collection and Binding reconciliation", () =>
  Effect.gen(function* () {
    const remote = yield* decode(manifest());
    const desired = yield* decode({
      ...manifest([{ skill: skillId }]),
      skills: [{ ...skill, local_version_id: second }],
    });
    const plan = planLibrarySync(desired, remote, desired);
    assert.deepEqual(plan.local, []);
    assert.deepEqual(plan.remote, [
      {
        kind: "collection",
        action: "update",
        subject_id: collectionId,
        label: "fixture/skills",
        label_before: "fixture/skills",
        label_after: "fixture/skills",
        skills_added: [],
        skills_removed: [],
        skills_changed: ["review"],
        evidence_only: false,
      },
      {
        kind: "binding",
        action: "add",
        entries_added: [{ kind: "skill", label: "review" }],
        entries_removed: [],
      },
    ]);
  }),
);

it.effect("marks a Collection whose only difference is fetch records as evidence-only", () =>
  Effect.gen(function* () {
    const remote = yield* decode(manifest());
    const refetched = manifest();
    const desired = yield* decode({
      ...refetched,
      imports: refetched.imports.map((acquisition, index) =>
        index === 0 ? { ...acquisition, imported_at: "2026-02-01T00:00:00.000Z" } : acquisition,
      ),
    });
    assert.deepEqual(planLibrarySync(desired, remote, desired).remote, [
      {
        kind: "collection",
        action: "update",
        subject_id: collectionId,
        label: "fixture/skills",
        label_before: "fixture/skills",
        label_after: "fixture/skills",
        skills_added: [],
        skills_removed: [],
        skills_changed: [],
        evidence_only: true,
      },
    ]);
  }),
);

it.effect(
  "aligns identical concurrent updates without losing device references or provenance",
  () =>
    Effect.gen(function* () {
      const localId = makeSkillVersionId();
      const base = yield* decode({
        ...manifest(),
        skills: [{ ...skill, versions: skill.versions.slice(0, 1) }],
      });
      const remote = yield* decode(manifest());
      const local = yield* decode({
        ...manifest(),
        skills: [
          {
            ...skill,
            versions: skill.versions.map((version) =>
              version.skill_version_id === second
                ? { ...version, skill_version_id: localId }
                : version,
            ),
          },
        ],
        imports: [...manifest().imports, { ...manifest().imports[0], import_id: makeImportId() }],
      });
      const original = structuredClone(local);
      const state = yield* Schema.decodeUnknownEffect(LibraryState)({
        schemaVersion: 10,
        ...local,
        enabled: [{ skill: skillId }],
        repositories: [],
        unmanaged: [],
        installed_skills: [
          {
            installed_skill_id: makeInstalledSkillId(),
            skill_id: skillId,
            skill_version_id: localId,
            destination: "agents",
            root: "/tmp/skills",
            path: "/tmp/skills/review",
            expected_digest: digestB,
            status: "installed",
            installed_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        assessmentAcceptances: [digestB, digestC].map((artifactContentDigest) => ({
          fingerprint: digest,
          artifactContentDigest,
          skill_version_id: localId,
          context: "project",
          principal: "test",
          rationale: "accepted",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        })),
      });
      const merged = yield* prepareLibraryMerge({ base, local, remote, device: state });
      if (merged._tag !== "Ready") return assert.fail(`Expected ready merge, got ${merged._tag}`);
      yield* decode(merged.manifest);
      assert.strictEqual(merged.manifest.imports.length, local.imports.length);
      assert.deepEqual(local, original);
      const device = merged.device;
      assert.deepEqual(
        strandedByRestore(device, { ...merged.manifest, enabled: state.enabled }),
        [],
      );
      assert.strictEqual(device.installed_skills[0]?.skill_version_id, second);
      assert.strictEqual(device.installed_skills[0]?.expected_digest, digestB);
      assert.strictEqual(device.assessmentAcceptances?.[0]?.skill_version_id, second);
      assert.strictEqual(device.assessmentAcceptances?.[1]?.skill_version_id, localId);
      assert.strictEqual(state.installed_skills[0]?.skill_version_id, localId);
      // A third device adopts the already published handle, and subsequent syncs are idempotent.
      const thirdDevice = {
        ...local,
        skills: local.skills.map((row) => ({
          ...row,
          versions: row.versions.map((version) => ({
            ...version,
            skill_version_id: makeSkillVersionId(),
          })),
        })),
      };
      const thirdAligned = aliasManifest(
        thirdDevice,
        alignLibrary(thirdDevice, merged.manifest, merged.manifest),
      );
      assert.deepEqual(thirdAligned.skills, merged.manifest.skills);
      assert.deepEqual(alignLibrary(thirdAligned, merged.manifest, merged.manifest).versions, []);
    }),
);

it.effect("aligns equivalent retained-edit selections but preserves different edit conflicts", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const localId = makeSkillVersionId();
    const local = yield* decode({
      ...manifest(),
      skills: [
        {
          ...skill,
          local_version_id: localId,
          versions: skill.versions.map((version) =>
            version.skill_version_id === second
              ? { ...version, skill_version_id: localId }
              : version,
          ),
        },
      ],
    });
    const remote = yield* decode({
      ...manifest(),
      skills: [{ ...skill, local_version_id: second }],
    });
    const aliases = alignLibrary(local, remote, base);
    const merged = mergeLibraryManifests(
      aliasManifest(base, aliases),
      aliasManifest(local, aliases),
      remote,
    );
    assert.deepEqual(merged.conflicts, []);
    assert.strictEqual(merged.manifest.skills[0]?.local_version_id, second);
    const different = yield* decode({
      ...manifest(),
      skills: [{ ...skill, local_version_id: third }],
    });
    const differentAliases = alignLibrary(local, different, base);
    assert.strictEqual(differentAliases.versions.length, 1);
    const differentBase = aliasManifest(base, differentAliases);
    const differentLocal = aliasManifest(local, differentAliases);
    const preliminary = mergeLibraryManifests(differentBase, differentLocal, different);
    assert.deepEqual(preliminary.conflicts, [`skill:${skillId}`]);
    const resolved = mergeLibraryManifests(
      differentBase,
      differentLocal,
      different,
      new Set(preliminary.conflicts),
    );
    assert.deepEqual(resolved.conflicts, []);
    assert.strictEqual(resolved.manifest.skills[0]?.local_version_id, third);
    yield* decode(resolved.manifest);
  }),
);

it.effect("does not alias different validation metadata or another Skill's versions", () =>
  Effect.gen(function* () {
    const base = yield* decode({
      ...manifest(),
      skills: [{ ...skill, versions: skill.versions.slice(0, 1) }],
    });
    const remote = yield* decode(manifest());
    const local = yield* decode({
      ...manifest(),
      skills: [
        {
          ...skill,
          versions: skill.versions.map((version) =>
            version.skill_version_id === second
              ? {
                  ...version,
                  skill_version_id: makeSkillVersionId(),
                  validation_identity_digest: digestC,
                }
              : version,
          ),
        },
      ],
    });
    const aliases = alignLibrary(local, remote, base);
    assert.deepEqual(aliases, { collections: [], skills: [], versions: [] });
    assert.deepEqual(mergeLibraryManifests(base, aliasManifest(local, aliases), remote).conflicts, [
      `skill:${skillId}`,
    ]);
    assert.deepEqual(
      alignLibrary(
        local,
        { ...remote, skills: remote.skills.map((row) => ({ ...row, skill_id: makeSkillId() })) },
        base,
      ),
      { collections: [], skills: [], versions: [] },
    );
  }),
);

it.effect("aligns only observed base IDs and preserves pruning decisions", () =>
  Effect.gen(function* () {
    const localId = makeSkillVersionId();
    const local = yield* decode({
      ...manifest(),
      skills: [
        {
          ...skill,
          versions: skill.versions.map((version) =>
            version.skill_version_id === second
              ? { ...version, skill_version_id: localId }
              : version,
          ),
        },
      ],
    });
    const remote = yield* decode(manifest());
    const aliases = alignLibrary(local, remote, local);
    const alignedBase = aliasManifest(local, aliases);
    assert.deepEqual(
      mergeLibraryManifests(alignedBase, aliasManifest(local, aliases), remote).conflicts,
      [],
    );
    const independentBase = {
      ...local,
      skills: local.skills.map((row) => ({
        ...row,
        versions: row.versions.map((version) =>
          version.skill_version_id === localId
            ? { ...version, skill_version_id: makeSkillVersionId() }
            : version,
        ),
      })),
    };
    assert.deepEqual(aliasManifest(independentBase, aliases), independentBase);
    const pruned = {
      ...local,
      skills: local.skills.map((row) => ({
        ...row,
        versions: row.versions.filter((version) => version.skill_version_id !== localId),
      })),
    };
    const result = mergeLibraryManifests(alignedBase, pruned, remote);
    assert.deepEqual(result.conflicts, []);
    assert.isFalse(
      result.manifest.skills[0]?.versions.some((version) => version.skill_version_id === second),
    );
  }),
);

// A Collection with two Skills, `alpha` and `beta`, observed by one source import.
const pairCollection = makeCollectionId();
const pairCopy = makeCollectionVersionId();
const pairDigest = `sha256:${"d".repeat(64)}`;
const alpha = makeSkillId();
const beta = makeSkillId();
const pairManifest = (entries: unknown[]) => ({
  schema: "skit.library.v8",
  collections: [{ collection_id: pairCollection, label: "fixture/pair" }],
  skills: [
    [alpha, "alpha", digestB],
    [beta, "beta", digestC],
  ].map(([skill_id, name, value]) => ({
    skill_id,
    collection_id: pairCollection,
    path: name,
    name,
    versions: [
      {
        skill_version_id: `${skill_id}`.replace("skill_", "skv_"),
        source_digest: value,
        artifact_digest: value,
        validation_identity_digest: value,
        materialization_profile: "plain-skill/v1" as const,
      },
    ],
  })),
  collection_versions: [
    {
      collection_version_id: pairCopy,
      digest: pairDigest,
      copy_profile: "verbatim/v1" as const,
      members: [
        ["alpha", digestB],
        ["beta", digestC],
      ].map(([source_path, value]) => ({
        source_path,
        source_digest: value,
        artifact_digest: value,
        materialization_profile: "plain-skill/v1" as const,
      })),
    },
  ],
  imports: [
    {
      import_id: makeImportId(),
      collection_id: pairCollection,
      kind: "source" as const,
      collection_version_id: pairCopy,
      source_identity: { kind: "local" as const, machine_id: machineId, path: { value: "/pair" } },
      input: { value: "/pair" },
      imported_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      lock_file_entries: [],
    },
  ],
  snapshot_digests: [pairDigest],
  enabled: entries,
});

it.effect(
  "keeps both Skills disabled when two devices each disable one of a followed Collection",
  () =>
    Effect.gen(function* () {
      const base = yield* decode(pairManifest([{ collection: pairCollection }]));
      // Disabling one Skill of a followed Collection rewrites it as the remaining Skill's entry.
      const local = yield* decode(pairManifest([{ skill: beta }]));
      const remote = yield* decode(pairManifest([{ skill: alpha }]));
      const merged = mergeLibraryManifests(base, local, remote);
      assert.deepEqual(merged.conflicts, []);
      assert.deepEqual(merged.manifest.enabled, []);
    }),
);

it.effect("keeps one device's disable when the other device changed nothing", () =>
  Effect.gen(function* () {
    const base = yield* decode(pairManifest([{ collection: pairCollection }]));
    const local = yield* decode(pairManifest([{ skill: beta }]));
    const remote = yield* decode(base);
    const merged = mergeLibraryManifests(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.manifest.enabled, [{ skill: beta }]);
  }),
);

it.effect(
  "merge preparation describes conflicts and applies a valid remote Collection choice",
  () =>
    Effect.gen(function* () {
      const base = yield* decode(manifest());
      const local = { ...base, collections: [{ ...base.collections[0]!, label: "local label" }] };
      const remote = { ...base, collections: [{ ...base.collections[0]!, label: "remote label" }] };
      const key = `collection:${collectionId}`;
      const conflict = yield* prepareLibraryMerge({ base, local, remote });
      assert.strictEqual(conflict._tag, "Conflicted");
      if (conflict._tag === "Conflicted") {
        assert.deepStrictEqual(
          conflict.conflicts.map((detail) => detail.key),
          [key],
        );
        assert.strictEqual(conflict.conflicts[0]?.resolution, "take-remote");
      }
      const prepared = yield* prepareLibraryMerge({ base, local, remote, takeRemote: [key] });
      if (prepared._tag !== "Ready")
        return assert.fail(`Expected ready merge, got ${prepared._tag}`);
      assert.strictEqual(prepared.manifest.collections[0]?.label, "remote label");
      assert.strictEqual(prepared.alignedLocal.collections[0]?.label, "local label");
      assert.strictEqual(local.collections[0]?.label, "local label");
      assert.strictEqual(base.collections[0]?.label, "fixture/skills");
      yield* decode(prepared.manifest);
    }),
);

it.effect("merge preparation rejects a requested key when there is no resolvable conflict", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const prepared = yield* prepareLibraryMerge({
      base,
      local: base,
      remote: base,
      takeRemote: [`collection:${collectionId}`],
    });
    assert.strictEqual(prepared._tag, "InvalidResolution");
  }),
);

it.effect(
  "normalization and input order preserve selected content when acquisition times tie",
  () =>
    Effect.gen(function* () {
      const input = yield* decode({
        ...manifest(),
        imports: manifest().imports.map((acquisition) => ({
          ...acquisition,
          kind: "source",
        })),
      });
      const ordered = [...input.imports].sort((a, b) => b.import_id.localeCompare(a.import_id));
      const expected = currentSkillVersion(input, input.skills[0]!);
      const expectedMembers = currentCollectionSkills(input, collectionId);
      for (const imports of [ordered, ordered.toReversed()]) {
        const candidate = { ...input, imports };
        const normalized = normalizeLibraryManifest(candidate);
        assert.deepStrictEqual(sourceImports(candidate, collectionId), ordered);
        assert.deepStrictEqual(currentSkillVersion(candidate, candidate.skills[0]!), expected);
        assert.deepStrictEqual(currentSkillVersion(normalized, normalized.skills[0]!), expected);
        assert.deepStrictEqual(currentCollectionSkills(normalized, collectionId), expectedMembers);
      }
    }),
);
