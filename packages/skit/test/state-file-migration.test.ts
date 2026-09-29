import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "../src/platform/layer.js";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeProjectionId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { currentSkillVersion } from "../src/library/library-contracts.js";
import { inspectLibrary } from "./helpers/library-store.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "library-state");

interface LegacySkillVersionFixture {
  readonly [field: string]: unknown;
}

it.effect("migrates a persisted v4 well-known subset to v6 once at the state-file boundary", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v4-migration-" });
    const fixture = yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json"));
    yield* fs.writeFileString(join(home, "state.json"), fixture);

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.schemaVersion, 6);
    assert.strictEqual(migrated.state.collections.length, 1);
    assert.strictEqual(migrated.state.acquisitions[0]?.kind, "source");
    assert.strictEqual(
      migrated.state.acquisitions[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
    assert.strictEqual(
      migrated.state.acquisitions[0]?.input.value,
      "wellknown:https://skills.example#skills=review",
    );
    assert.deepStrictEqual(Object.keys(migrated.state.collections[0]?.upstream ?? {}).sort(), [
      "source_identity",
      "tracking",
    ]);
    assert.strictEqual(
      migrated.state.skills[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
    const skillId = migrated.state.skills[0]!.skill_id;
    const collectionId = migrated.state.collections[0]!.collection_id;
    // Every current Skill of the Collection was bound, so the Collection is bound.
    assert.deepStrictEqual(migrated.state.global_bindings[0]?.entries, [
      { kind: "collection", collection_id: collectionId },
    ]);
    assert.strictEqual(
      migrated.state.global_bindings[0]?.invocation_policies?.[skillId],
      "explicit",
    );
    assert.deepStrictEqual(migrated.state.local_bindings[0]?.scope, {
      kind: "repository",
      root: "/workspace",
    });
    assert.deepStrictEqual(migrated.state.local_bindings[0]?.entries, [
      { kind: "collection", collection_id: collectionId },
    ]);
    assert.strictEqual(
      migrated.state.local_bindings[0]?.invocation_policies?.[skillId],
      "implicit",
    );
    assert.strictEqual(migrated.state.projections.length, 1);
    assert.strictEqual(migrated.state.projections[0]?.skill_id, migrated.state.skills[0]?.skill_id);
    assert.strictEqual("collection_id" in migrated.state.projections[0]!, false);

    assert.ok(
      (yield* fs.readDirectory(home)).some((name) => name.startsWith("state.json.v4.backup-")),
    );

    const reopened = yield* inspectLibrary(home);
    assert.strictEqual(reopened.present, true);
    if (!reopened.present) return;
    assert.deepStrictEqual(reopened.state, migrated.state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("merges legacy well-known subsets from the same origin deterministically", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v4-merge-" });
    const fixture = JSON.parse(
      yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json")),
    );
    const firstCollection = fixture.collections[0];
    const firstSkill = fixture.skills[0];
    const firstAcquisition = fixture.acquisitions[0];
    const secondCollectionId = makeCollectionId();
    const secondAcquisitionId = makeAcquisitionId();
    const secondCopyId = makeRetainedCopyId();
    fixture.retained_copies.push({
      ...fixture.retained_copies[0],
      retained_copy_id: secondCopyId,
      digest: `sha256:${"c".repeat(64)}`,
      members: fixture.retained_copies[0].members.map((member: object) => ({
        ...member,
        source_path: "tdd",
      })),
    });
    fixture.collections.push({
      ...firstCollection,
      collection_id: secondCollectionId,
      display_name: "skills.example#tdd",
    });
    fixture.skills.push({
      ...firstSkill,
      skill_id: makeSkillId(),
      collection_id: secondCollectionId,
      path: "tdd",
      name: "tdd",
      upstream_path: "tdd",
      versions: firstSkill.versions.map((version: LegacySkillVersionFixture) => {
        const skillVersionId = makeSkillVersionId();
        return {
          ...version,
          skill_version_id: skillVersionId,
          origins: [{ acquisition_id: secondAcquisitionId, source_path: "tdd" }],
        };
      }),
    });
    fixture.skills[1].selected_skill_version_id = fixture.skills[1].versions[0].skill_version_id;
    fixture.acquisitions.push({
      ...firstAcquisition,
      acquisition_id: secondAcquisitionId,
      retained_copy_id: secondCopyId,
      input: { value: "wellknown:https://skills.example#skills=tdd" },
      acquired_at: "2026-09-20T00:01:00.000Z",
    });
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(fixture));

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.collections.length, 1);
    assert.strictEqual(new Set(migrated.state.skills.map((skill) => skill.collection_id)).size, 1);
    assert.strictEqual(
      migrated.state.skills[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("migrates v5 state: whole Sources, entries, retained edits, all history kept", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v5-migration-" });
    const machineId = makeMachineId();
    const collectionId = makeCollectionId();
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const ids = {
      alpha: makeSkillId(),
      beta: makeSkillId(),
      gone: makeSkillId(),
      dropped: makeSkillId(),
      alpha1: makeSkillVersionId(),
      alpha2: makeSkillVersionId(),
      beta1: makeSkillVersionId(),
      betaEdit: makeSkillVersionId(),
      gone1: makeSkillVersionId(),
      dropped1: makeSkillVersionId(),
      first: makeAcquisitionId(),
      second: makeAcquisitionId(),
      edit: makeAcquisitionId(),
      firstCopy: makeRetainedCopyId(),
      secondCopy: makeRetainedCopyId(),
      editCopy: makeRetainedCopyId(),
    };
    const version = (id: string, character: string, origins: [string, string][]) => ({
      skill_version_id: id,
      source_digest: digest(character),
      artifact_digest: digest(character),
      validation_identity_digest: digest(character),
      materialization_profile: "plain-skill/v1",
      origins: origins.map(([acquisition_id, source_path]) => ({ acquisition_id, source_path })),
    });
    const member = (source_path: string, character: string) => ({
      source_path,
      source_digest: digest(character),
      artifact_digest: digest(character),
      materialization_profile: "plain-skill/v1",
    });
    const github = {
      kind: "github" as const,
      owner: "fixture",
      repository: "skills",
      collection_root: ".",
    };
    const sourceAcquisition = (id: string, copy: string, revision: string, at: string) => ({
      acquisition_id: id,
      retained_copy_id: copy,
      source_identity: github,
      tracking: { kind: "commit", ref: revision },
      selection: { kind: "selected-paths", paths: ["alpha", "beta", "dropped", "gone"] },
      input: { value: "https://github.com/fixture/skills" },
      source_revision: revision,
      acquired_at: at,
      machine_id: machineId,
      observations: [],
    });
    const v5 = {
      schemaVersion: 5,
      unmanaged: [],
      collections: [
        {
          collection_id: collectionId,
          label: "fixture/skills",
          upstream: {
            source_identity: github,
            tracking: { kind: "default" },
            selection: { kind: "selected-paths", paths: ["alpha", "beta", "dropped", "gone"] },
            last_acquisition_id: ids.second,
          },
        },
      ],
      skills: [
        {
          skill_id: ids.alpha,
          collection_id: collectionId,
          path: "alpha",
          name: "alpha",
          selected_skill_version_id: ids.alpha2,
          versions: [
            version(ids.alpha1, "1", [[ids.first, "alpha"]]),
            version(ids.alpha2, "2", [[ids.second, "alpha"]]),
          ],
        },
        {
          skill_id: ids.beta,
          collection_id: collectionId,
          path: "beta",
          name: "beta",
          selected_skill_version_id: ids.betaEdit,
          versions: [
            version(ids.beta1, "3", [
              [ids.first, "beta"],
              [ids.second, "beta"],
            ]),
            version(ids.betaEdit, "4", [[ids.edit, "."]]),
          ],
        },
        {
          skill_id: ids.gone,
          collection_id: collectionId,
          path: "gone",
          name: "gone",
          selected_skill_version_id: ids.gone1,
          versions: [version(ids.gone1, "5", [[ids.first, "gone"]])],
        },
        {
          skill_id: ids.dropped,
          collection_id: collectionId,
          path: "dropped",
          name: "dropped",
          selected_skill_version_id: ids.dropped1,
          versions: [version(ids.dropped1, "6", [[ids.first, "dropped"]])],
        },
      ],
      retained_copies: [
        {
          retained_copy_id: ids.firstCopy,
          digest: digest("a"),
          copy_profile: "verbatim/v1",
          members: [
            member("alpha", "1"),
            member("beta", "3"),
            member("dropped", "6"),
            member("gone", "5"),
          ],
        },
        {
          retained_copy_id: ids.secondCopy,
          digest: digest("b"),
          copy_profile: "verbatim/v1",
          members: [member("alpha", "2"), member("beta", "3")],
        },
        {
          retained_copy_id: ids.editCopy,
          digest: digest("c"),
          copy_profile: "verbatim/v1",
          members: [member(".", "4")],
        },
      ],
      acquisitions: [
        sourceAcquisition(ids.first, ids.firstCopy, "1".repeat(40), "2026-09-16T01:00:00.000Z"),
        sourceAcquisition(ids.second, ids.secondCopy, "2".repeat(40), "2026-09-16T02:00:00.000Z"),
        {
          acquisition_id: ids.edit,
          retained_copy_id: ids.editCopy,
          source_identity: {
            kind: "local",
            machine_id: machineId,
            path: { value: "/codex/beta" },
          },
          tracking: { kind: "default" },
          selection: { kind: "full-tree" },
          input: { value: "/codex/beta" },
          acquired_at: "2026-09-16T03:00:00.000Z",
          machine_id: machineId,
          observations: [],
        },
      ],
      global_bindings: [
        // Every current Skill (alpha, beta) is bound: this becomes the Collection.
        { harness: "codex", scope: { kind: "global" }, skills: [ids.alpha, ids.beta] },
        // A Skill deleted upstream, bound on its own, is kept.
        { harness: "claude-code", scope: { kind: "global" }, skills: [ids.gone] },
      ],
      local_bindings: [],
      projections: [
        {
          projection_id: makeProjectionId(),
          skill_id: ids.alpha,
          skill_version_id: ids.alpha1,
          harness: "codex",
          root: "/codex",
          path: "/codex/alpha",
          expected_digest: digest("1"),
          status: "installed",
          projected_at: "2026-09-16T01:30:00.000Z",
        },
      ],
    };
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(v5));

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    const state = migrated.state;
    assert.strictEqual(state.schemaVersion, 6);
    assert.ok(
      (yield* fs.readDirectory(home)).some((name) => name.startsWith("state.json.v5.backup-")),
    );
    assert.deepStrictEqual(state.collections[0]?.upstream, {
      source_identity: github,
      tracking: { kind: "default" },
    });

    // Migration keeps every Acquisition and Skill, even `dropped`, which upstream deleted and
    // nothing uses.
    assert.deepStrictEqual(
      state.acquisitions.map((item) => [item.acquisition_id, item.kind, item.revision]),
      [
        [ids.first, "source", "1".repeat(40)],
        [ids.second, "source", "2".repeat(40)],
        [ids.edit, "retained-edit", undefined],
      ],
    );
    assert.deepStrictEqual(
      state.skills.map((skill) => skill.name),
      ["alpha", "beta", "gone", "dropped"],
    );
    const skill = (id: string) => state.skills.find((candidate) => candidate.skill_id === id)!;
    assert.strictEqual(currentSkillVersion(state, skill(ids.alpha))?.skill_version_id, ids.alpha2);
    assert.deepStrictEqual(
      skill(ids.alpha).versions.map((item) => item.skill_version_id),
      [ids.alpha1, ids.alpha2],
    );
    assert.strictEqual(skill(ids.beta).local_version_id, ids.betaEdit);
    assert.strictEqual(currentSkillVersion(state, skill(ids.beta))?.skill_version_id, ids.betaEdit);
    assert.strictEqual(currentSkillVersion(state, skill(ids.gone))?.skill_version_id, ids.gone1);
    assert.deepStrictEqual(
      state.global_bindings.map((binding) => [binding.harness, binding.entries]),
      [
        ["codex", [{ kind: "collection", collection_id: collectionId }]],
        ["claude-code", [{ kind: "skill", skill_id: ids.gone }]],
      ],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
