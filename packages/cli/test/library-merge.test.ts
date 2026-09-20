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
} from "@smolai/skit-core";
import { mergeLibraryManifests } from "../src/workflows/library/library-merge.js";
import { planLibrarySync } from "../src/workflows/library/library-sync-plan.js";
import { deferredLibraryBindings } from "../src/workflows/library/library-sync.js";

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
  selected_skill_version_id: versionId,
  versions: [
    {
      skill_version_id: versionId,
      source_digest: digest,
      artifact_digest: digest,
      validation_identity_digest: digest,
      materialization_profile: "plain-skill/v1" as const,
      origins: [{ acquisition_id: acquisitionId, source_path: "." as const }],
    },
    {
      skill_version_id: second,
      source_digest: digestB,
      artifact_digest: digestB,
      validation_identity_digest: digestB,
      materialization_profile: "plain-skill/v1" as const,
      origins: [{ acquisition_id: acquisitionB, source_path: "." as const }],
    },
    {
      skill_version_id: third,
      source_digest: digestC,
      artifact_digest: digestC,
      validation_identity_digest: digestC,
      materialization_profile: "plain-skill/v1" as const,
      origins: [{ acquisition_id: acquisitionC, source_path: "." as const }],
    },
  ],
};
const manifest = (bindings: unknown[] = []) => ({
  schema: "skit.library.v5",
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
      retained_copy_id: retainedCopyId,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: "/tmp/fixture" },
      },
      tracking: { kind: "default" as const },
      selection: { kind: "full-tree" as const },
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
      retained_copy_id,
      source_identity: {
        kind: "local" as const,
        machine_id: machineId,
        path: { value: "/tmp/fixture" },
      },
      tracking: { kind: "default" as const },
      selection: { kind: "full-tree" as const },
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
          collection_id: collection.collection_id,
          harness: "codex",
          scope: { kind: "global" },
          skills: [skillId],
        },
      ]),
    );
    const merged = mergeLibraryManifests(base, local, base);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.manifest.bindings, local.bindings);
  }),
);

it.effect("reports concurrent Skill selection changes without choosing a winner", () =>
  Effect.gen(function* () {
    const base = yield* decode(manifest());
    const select = (id: typeof versionId) => ({
      ...manifest(),
      skills: [{ ...skill, selected_skill_version_id: id }],
    });
    const local = yield* decode(select(second));
    const remote = yield* decode(select(third));
    const conflicted = mergeLibraryManifests(base, local, remote);
    assert.deepEqual(conflicted.conflicts, [`skill:${skillId}`]);
    const accepted = mergeLibraryManifests(base, local, remote, new Set([`skill:${skillId}`]));
    assert.deepEqual(accepted.conflicts, []);
    assert.strictEqual(accepted.manifest.skills[0]?.selected_skill_version_id, third);
  }),
);

it.effect("plans destination-specific Collection and Binding reconciliation", () =>
  Effect.gen(function* () {
    const remote = yield* decode(manifest());
    const desired = yield* decode({
      ...manifest([
        {
          collection_id: collection.collection_id,
          harness: "codex",
          scope: { kind: "global" },
          skills: [skillId],
        },
      ]),
      skills: [{ ...skill, selected_skill_version_id: second }],
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
        skills_before: ["review"],
        skills_after: ["review"],
        versions_before: [`review @ ${digest}`],
        versions_after: [`review @ ${digestB}`],
        evidence_changed: false,
      },
      {
        kind: "binding",
        action: "add",
        harness: "codex",
        skills_before: [],
        skills_after: ["review"],
        versions_before: [],
        versions_after: [],
        evidence_changed: false,
      },
    ]);
  }),
);

it.effect("names every deferred Binding and its affected Skills", () =>
  Effect.gen(function* () {
    const portable = yield* decode(
      manifest([
        {
          collection_id: collection.collection_id,
          harness: "codex",
          scope: { kind: "global" },
          skills: [skillId],
        },
        {
          collection_id: collection.collection_id,
          harness: "claude-code",
          scope: { kind: "global" },
          skills: [skillId],
        },
      ]),
    );
    assert.deepEqual(
      deferredLibraryBindings(portable, (harness) =>
        harness === "codex" ? "/available" : undefined,
      ),
      [{ harness: "claude-code", skills: ["review"] }],
    );
  }),
);
