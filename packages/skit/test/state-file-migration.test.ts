import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "../src/platform/layer.js";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { inspectLibrary } from "./helpers/library-store.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "library-state");

it.effect("migrates a persisted v4 well-known subset once at the state-file boundary", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v4-migration-" });
    const fixture = yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json"));
    yield* fs.writeFileString(join(home, "state.json"), fixture);

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.schemaVersion, 5);
    assert.strictEqual(migrated.state.collections.length, 1);
    assert.deepStrictEqual(migrated.state.acquisitions[0]?.selection, {
      kind: "selected-skills",
      names: ["review"],
    });
    assert.strictEqual(
      migrated.state.acquisitions[0]?.input.value,
      "wellknown:https://skills.example#skills=review",
    );
    assert.deepStrictEqual(migrated.state.collections[0]?.upstream?.selection, {
      kind: "selected-skills",
      names: ["review"],
    });
    assert.strictEqual(
      migrated.state.skills[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
    const skillId = migrated.state.skills[0]!.skill_id;
    assert.deepStrictEqual(migrated.state.global_bindings[0]?.skills, [skillId]);
    assert.strictEqual(
      migrated.state.global_bindings[0]?.invocation_policies?.[skillId],
      "explicit",
    );
    assert.deepStrictEqual(migrated.state.local_bindings[0]?.scope, {
      kind: "repository",
      root: "/workspace",
    });
    assert.deepStrictEqual(migrated.state.local_bindings[0]?.skills, [skillId]);
    assert.strictEqual(
      migrated.state.local_bindings[0]?.invocation_policies?.[skillId],
      "implicit",
    );
    assert.strictEqual(migrated.state.projections.length, 1);
    assert.strictEqual(migrated.state.projections[0]?.skill_id, migrated.state.skills[0]?.skill_id);
    assert.strictEqual("collection_id" in migrated.state.projections[0]!, false);

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
      versions: firstSkill.versions.map((version: Record<string, unknown>) => {
        const skillVersionId = makeSkillVersionId();
        return {
          ...version,
          skill_version_id: skillVersionId,
          origins: [{ acquisition_id: secondAcquisitionId, source_path: "review" }],
        };
      }),
    });
    fixture.skills[1].selected_skill_version_id = fixture.skills[1].versions[0].skill_version_id;
    fixture.acquisitions.push({
      ...firstAcquisition,
      acquisition_id: secondAcquisitionId,
      input: { value: "wellknown:https://skills.example#skills=tdd" },
      acquired_at: "2026-09-20T00:01:00.000Z",
    });
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(fixture));

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.collections.length, 1);
    assert.deepStrictEqual(migrated.state.collections[0]?.upstream?.selection, {
      kind: "selected-skills",
      names: ["review", "tdd"],
    });
    assert.strictEqual(new Set(migrated.state.skills.map((skill) => skill.collection_id)).size, 1);
    assert.strictEqual(
      migrated.state.skills[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
