import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { LibraryManifest, inspectOwnershipMarker, makeSkillVersionId } from "@smolai/skit-core";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { devices } from "./helpers/library-sync-devices.js";

it.effect(
  "syncs independent identical updates with installed-skill custody and a read-only preview",
  () =>
    Effect.gen(function* () {
      const { fs, a, b, server } = yield* devices;
      const initial = yield* a.importSource("skills", {
        name: "review",
        bytes: "initial bytes\n",
        importedAt: "2026-01-01T00:00:00.000Z",
      });
      const skillId = initial.skills[0]?.skill_id;
      assert.ok(skillId);
      yield* a.edit((state) => ({
        ...state,
        enabled: [{ skill: skillId }],
      }));
      yield* a.project();
      assert.strictEqual((yield* a.sync()).status, "pushed");
      assert.strictEqual((yield* b.sync()).status, "pulled");
      yield* a.importSource("skills", {
        name: "review",
        bytes: "updated identical bytes\n",
        importedAt: "2026-01-02T00:00:00.000Z",
      });
      yield* b.importSource("skills", {
        name: "review",
        bytes: "updated identical bytes\n",
        importedAt: "2026-01-02T00:00:01.000Z",
      });
      yield* a.project();
      yield* b.project();
      const aBefore = yield* a.state;
      const bBefore = yield* b.state;
      const publishedId = aBefore.installed_skills[0]?.skill_version_id;
      assert.ok(publishedId);
      assert.notStrictEqual(publishedId, bBefore.installed_skills[0]?.skill_version_id);
      assert.strictEqual((yield* a.sync()).status, "merged");
      const writesBeforePreview = server.writes;
      const previewUntouched = yield* captureDisk(b.disk);
      const markerBefore = yield* fs.readFileString(join(b.root, "review", ".skit-ownership.json"));
      assert.strictEqual((yield* b.sync({ apply: false })).status, "merge_ready");
      yield* assertDiskUnchanged(previewUntouched);
      assert.strictEqual(server.writes, writesBeforePreview);
      assert.deepEqual(yield* b.state, bBefore);
      assert.strictEqual(
        yield* fs.readFileString(join(b.root, "review", ".skit-ownership.json")),
        markerBefore,
      );
      assert.strictEqual((yield* b.sync()).status, "merged");
      const bAfter = yield* b.state;
      assert.strictEqual(bAfter.installed_skills[0]?.skill_version_id, publishedId);
      assert.strictEqual(
        bAfter.installed_skills[0]?.installed_skill_id,
        bBefore.installed_skills[0]?.installed_skill_id,
      );
      assert.strictEqual(
        bAfter.installed_skills[0]?.expected_hash,
        bBefore.installed_skills[0]?.expected_hash,
      );
      assert.strictEqual(bAfter.imports.length, 3);
      assert.strictEqual(bAfter.collection_versions.length, 3);
      const marker = yield* inspectOwnershipMarker(join(b.root, "review"));
      assert.strictEqual(marker.kind, "valid");
      if (marker.kind === "valid") assert.strictEqual(marker.marker.skill_version_id, publishedId);
      assert.strictEqual(
        yield* fs.readFileString(join(b.root, "review", "SKILL.md")),
        "updated identical bytes\n",
      );
      assert.strictEqual((yield* a.sync()).status, "merged");
      assert.strictEqual((yield* b.sync()).status, "clean");
      assert.strictEqual((yield* a.sync()).status, "clean");
      assert.strictEqual(server.writes, writesBeforePreview + 1);
      // An equivalent handle must not hide a conflicting selection or invalidate --take-remote.
      const oldVersionId = initial.skills[0]?.versions[0]?.skill_version_id;
      assert.ok(oldVersionId);
      yield* a.edit((state) => ({
        ...state,
        skills: state.skills.map((skill) => ({ ...skill, local_version_id: oldVersionId })),
      }));
      yield* a.project();
      assert.strictEqual((yield* a.sync()).status, "merged");
      const equivalentId = makeSkillVersionId();
      yield* b.edit((state) => ({
        ...state,
        skills: state.skills.map((skill) => ({
          ...skill,
          local_version_id: equivalentId,
          versions: skill.versions.map((version) =>
            version.skill_version_id === publishedId
              ? { ...version, skill_version_id: equivalentId }
              : version,
          ),
        })),
        installed_skills: state.installed_skills.map((installedSkill) => ({
          ...installedSkill,
          skill_version_id: equivalentId,
        })),
      }));
      const conflicted = yield* b.sync({ apply: false });
      assert.strictEqual(conflicted.status, "conflicted");
      if (conflicted.status === "conflicted")
        assert.include(conflicted.conflicts, `skill:${skillId}`);
      assert.strictEqual((yield* b.sync({ takeRemote: [`skill:${skillId}`] })).status, "merged");
      const resolved = yield* b.state;
      assert.strictEqual(resolved.skills[0]?.local_version_id, oldVersionId);
      assert.strictEqual(resolved.installed_skills[0]?.skill_version_id, oldVersionId);
      assert.strictEqual(
        yield* fs.readFileString(join(b.root, "review", "SKILL.md")),
        "initial bytes\n",
      );
      const latest = yield* Effect.sync(() => server.remote);
      assert.ok(latest);
      yield* LibraryManifest.makeEffect(latest.manifest);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
