import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
  LibraryManifest,
  LibraryManifestAnyVersion,
  LibraryState,
  makeProjectionId,
  restoreCustodyConflicts,
} from "@smolai/skit-core";
import { mergeLibraryManifests } from "../src/workflows/library/library-merge.js";
import { planLibrarySync } from "../src/workflows/library/library-sync-plan.js";

import {
  alignLibraryVersionIds,
  applyLibraryVersionAliases,
  applyDeviceVersionAliases,
} from "../src/workflows/library/library-version-alignment.js";

const digest = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const decode = Schema.decodeUnknownEffect(LibraryManifest);
const skillId = makeSkillId();
const versionId = makeSkillVersionId();
const collectionId = makeCollectionId();
const acquisitionId = makeAcquisitionId();
const retainedCopyId = makeRetainedCopyId();
const machineId = makeMachineId();
const second = makeSkillVersionId();
const third = makeSkillVersionId();
const acquisitionB = makeAcquisitionId();
const acquisitionC = makeAcquisitionId();
const copyB = makeRetainedCopyId();
const copyC = makeRetainedCopyId();
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
const manifest = (bindings: unknown[] = []) => ({
  schema: "skit.library.v7",
  collections: [collection],
  skills: [skill],
  retained_copies: [
    {
      retained_copy_id: retainedCopyId,
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
    ].map(([retained_copy_id, value]) => ({
      retained_copy_id,
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
  acquisitions: [
    {
      acquisition_id: acquisitionId,
      collection_id: collectionId,
      kind: "source" as const,
      retained_copy_id: retainedCopyId,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: "/tmp/fixture" },
      },
      input: { value: "/tmp/fixture" },
      acquired_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      observations: [],
    },
    ...[
      [acquisitionB, copyB],
      [acquisitionC, copyC],
    ].map(([acquisition_id, retained_copy_id]) => ({
      acquisition_id,
      collection_id: collectionId,
      // Later Versions are retained local edits, so the Source keeps observing the first.
      kind: "retained-edit" as const,
      retained_copy_id,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: "/tmp/fixture" },
      },
      input: { value: "/tmp/fixture" },
      acquired_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      observations: [],
    })),
  ],
  snapshot_digests: [digest, digestB, digestC],
  bindings,
});

it.effect("merges an independently added global Binding", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const local = yield* decode(
      manifest([
        {
          scope: { kind: "global" },
          entries: [{ kind: "skill", skill_id: skillId }],
        },
      ]),
    );
    const merged = mergeLibraryManifests(base, local, base);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.manifest.bindings, local.bindings);
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
      ...manifest([
        {
          scope: { kind: "global" },
          entries: [{ kind: "skill", skill_id: skillId }],
        },
      ]),
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

it.effect("merges a v6 manifest's per-Harness Bindings into one global Binding", () =>
  Effect.gen(function* () {
    const v6 = {
      ...manifest(),
      schema: "skit.library.v6",
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
    };
    const decoded = yield* Schema.decodeUnknownEffect(LibraryManifestAnyVersion)(v6);
    assert.strictEqual(decoded.schema, "skit.library.v7");
    // The Skill entry is covered by its whole-Collection entry, so only the Collection remains.
    assert.deepEqual(decoded.bindings, [
      {
        scope: { kind: "global" },
        entries: [{ kind: "collection", collection_id: collectionId }],
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
      acquisitions: refetched.acquisitions.map((acquisition, index) =>
        index === 0 ? { ...acquisition, acquired_at: "2026-02-01T00:00:00.000Z" } : acquisition,
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
        acquisitions: [
          ...manifest().acquisitions,
          { ...manifest().acquisitions[0], acquisition_id: makeAcquisitionId() },
        ],
      });
      const original = structuredClone(local);
      const aligned = alignLibraryVersionIds(local, remote);
      const merged = mergeLibraryManifests(
        applyLibraryVersionAliases(base, aligned.aliases),
        aligned.manifest,
        remote,
      );
      assert.deepEqual(merged.conflicts, []);
      yield* decode(merged.manifest);
      assert.strictEqual(merged.manifest.acquisitions.length, local.acquisitions.length);
      assert.deepEqual(local, original);
      const state = yield* Schema.decodeUnknownEffect(LibraryState)({
        schemaVersion: 8,
        ...local,
        global_bindings: [
          {
            scope: { kind: "global" },
            entries: [{ kind: "skill", skill_id: skillId }],
          },
        ],
        local_bindings: [],
        unmanaged: [],
        projections: [
          {
            projection_id: makeProjectionId(),
            skill_id: skillId,
            skill_version_id: localId,
            target: "agents",
            root: "/tmp/skills",
            path: "/tmp/skills/review",
            expected_digest: digestB,
            status: "installed",
            projected_at: "2026-01-01T00:00:00.000Z",
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
      const device = applyDeviceVersionAliases(state, aligned.aliases);
      yield* LibraryState.makeEffect(device);
      assert.deepEqual(
        restoreCustodyConflicts(device, { ...merged.manifest, bindings: state.global_bindings }),
        [],
      );
      assert.strictEqual(device.projections[0]?.skill_version_id, second);
      assert.strictEqual(device.projections[0]?.expected_digest, digestB);
      assert.strictEqual(device.assessmentAcceptances?.[0]?.skill_version_id, second);
      assert.strictEqual(device.assessmentAcceptances?.[1]?.skill_version_id, localId);
      assert.strictEqual(state.projections[0]?.skill_version_id, localId);
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
      const thirdAligned = alignLibraryVersionIds(thirdDevice, merged.manifest);
      assert.deepEqual(thirdAligned.manifest.skills, merged.manifest.skills);
      assert.deepEqual(alignLibraryVersionIds(thirdAligned.manifest, merged.manifest).aliases, []);
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
    const aligned = alignLibraryVersionIds(local, remote);
    const merged = mergeLibraryManifests(
      applyLibraryVersionAliases(base, aligned.aliases),
      aligned.manifest,
      remote,
    );
    assert.deepEqual(merged.conflicts, []);
    assert.strictEqual(merged.manifest.skills[0]?.local_version_id, second);
    const different = yield* decode({
      ...manifest(),
      skills: [{ ...skill, local_version_id: third }],
    });
    const differentAligned = alignLibraryVersionIds(local, different);
    assert.strictEqual(differentAligned.aliases.length, 1);
    const differentBase = applyLibraryVersionAliases(base, differentAligned.aliases);
    const preliminary = mergeLibraryManifests(differentBase, differentAligned.manifest, different);
    assert.deepEqual(preliminary.conflicts, [`skill:${skillId}`]);
    const resolved = mergeLibraryManifests(
      differentBase,
      differentAligned.manifest,
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
    const aligned = alignLibraryVersionIds(local, remote);
    assert.deepEqual(aligned.aliases, []);
    assert.deepEqual(mergeLibraryManifests(base, aligned.manifest, remote).conflicts, [
      `skill:${skillId}`,
    ]);
    assert.deepEqual(
      alignLibraryVersionIds(local, {
        ...remote,
        skills: remote.skills.map((row) => ({ ...row, skill_id: makeSkillId() })),
      }).aliases,
      [],
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
    const aligned = alignLibraryVersionIds(local, remote);
    const alignedBase = applyLibraryVersionAliases(local, aligned.aliases);
    assert.deepEqual(mergeLibraryManifests(alignedBase, aligned.manifest, remote).conflicts, []);
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
    assert.deepEqual(applyLibraryVersionAliases(independentBase, aligned.aliases), independentBase);
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

// A Collection with two Skills, `alpha` and `beta`, observed by one Source Acquisition.
const pairCollection = makeCollectionId();
const pairCopy = makeRetainedCopyId();
const pairDigest = `sha256:${"d".repeat(64)}`;
const alpha = makeSkillId();
const beta = makeSkillId();
const pairManifest = (entries: unknown[]) => ({
  schema: "skit.library.v7",
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
  retained_copies: [
    {
      retained_copy_id: pairCopy,
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
  acquisitions: [
    {
      acquisition_id: makeAcquisitionId(),
      collection_id: pairCollection,
      kind: "source" as const,
      retained_copy_id: pairCopy,
      source_identity: { kind: "local" as const, machine_id: machineId, path: { value: "/pair" } },
      input: { value: "/pair" },
      acquired_at: "2026-01-01T00:00:00.000Z",
      machine_id: machineId,
      observations: [],
    },
  ],
  snapshot_digests: [pairDigest],
  bindings: entries.length ? [{ scope: { kind: "global" }, entries }] : [],
});

it.effect(
  "keeps both Skills disabled when two devices each disable one of a followed Collection",
  () =>
    Effect.gen(function* () {
      const base = yield* decode(
        pairManifest([{ kind: "collection", collection_id: pairCollection }]),
      );
      // Disabling one Skill of a followed Collection rewrites it as the remaining Skill's entry.
      const local = yield* decode(pairManifest([{ kind: "skill", skill_id: beta }]));
      const remote = yield* decode(pairManifest([{ kind: "skill", skill_id: alpha }]));
      const merged = mergeLibraryManifests(base, local, remote);
      assert.deepEqual(merged.conflicts, []);
      assert.deepEqual(merged.manifest.bindings, []);
    }),
);

it.effect("keeps one device's disable when the other device changed nothing", () =>
  Effect.gen(function* () {
    const base = yield* decode(
      pairManifest([{ kind: "collection", collection_id: pairCollection }]),
    );
    const local = yield* decode(pairManifest([{ kind: "skill", skill_id: beta }]));
    const remote = yield* decode(base);
    const merged = mergeLibraryManifests(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.manifest.bindings, [
      { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: beta }] },
    ]);
  }),
);
