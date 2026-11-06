import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { previewSyncInstalledSkills } from "../src/library/internal/sync/installed-skills.js";
import { resolveSyncInstalledSkillCollisions } from "../src/library/internal/sync/collisions.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

it.effect("Sync planning protects edited copies without saving state or moving files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-plan-" }),
    );
    const home = join(root, "library");
    const skills = join(root, "skills");
    const source = join(root, "source");
    const bytes = "---\nname: review\ndescription: Sync planning fixture\n---\nOriginal bytes.\n";
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
    const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
    if (Option.isNone(request)) return yield* Effect.die("Expected a local Skill");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const imported = yield* library.import.collection(request.value);
      const skill = imported.skills[0];
      if (!skill) return yield* Effect.die("Expected an imported Skill");
      const plan = yield* library.plan(
        {
          _tag: "Enabled",
          changes: [
            {
              _tag: "Enable",
              subject: { _tag: "Skill", id: skill.skill_id },
              where: [{ kind: "global" }],
            },
          ],
        },
        { base: yield* library.read },
      );
      assert.strictEqual(
        (yield* library.apply({ _tag: "Apply", plan: plan })).result._tag,
        "Applied",
      );
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Expected a Library");
      const current = snapshot.state;
      const copy = current.installed_skills[0];
      if (!copy) return yield* Effect.die("Expected an installed copy");
      const document = join(copy.path, "SKILL.md");
      yield* fs.writeFileString(document, "User's unimported edit.\n");
      const before = yield* fs.readFileString(join(home, "state.json"));
      const marker = yield* fs.readFileString(join(copy.path, ".skit-ownership.json"));
      const aligned = { ...current, enabled: [] };
      const manifest = yield* libraryManifestFromLocalState(aligned);
      const rootFor = (destination: string) => (destination === "agents" ? skills : undefined);
      const strict = yield* previewSyncInstalledSkills(current, aligned, manifest, rootFor, false);
      assert.lengthOf(strict.conflicts, 1);
      assert.deepEqual(strict.retire, []);
      assert.deepEqual(strict.remove, []);
      const deferred = yield* previewSyncInstalledSkills(current, aligned, manifest, rootFor, true);
      assert.deepEqual(deferred.conflicts, []);
      assert.lengthOf(deferred.issues, 1);
      assert.strictEqual(deferred.projections[0]?.status, "conflicted");
      assert.deepEqual(deferred.retire, []);
      const inactive = yield* previewSyncInstalledSkills(
        current,
        aligned,
        manifest,
        () => undefined,
        false,
      );
      assert.deepEqual(inactive.conflicts, []);
      assert.deepEqual(inactive.retire, []);
      assert.strictEqual(inactive.projections[0]?.status, "conflicted");
      assert.strictEqual(yield* fs.readFileString(document), "User's unimported edit.\n");
      assert.strictEqual(yield* fs.readFileString(join(copy.path, ".skit-ownership.json")), marker);
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
      assert.strictEqual(yield* fs.readFileString(join(source, "SKILL.md")), bytes);
      yield* fs.writeFileString(document, bytes);
      const clean = yield* previewSyncInstalledSkills(current, aligned, manifest, rootFor, false);
      assert.deepEqual(clean.conflicts, []);
      assert.deepEqual(clean.retire, [copy.installed_skill_id]);
      assert.deepEqual(clean.remove, [copy.installed_skill_id]);
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
      assert.strictEqual(yield* fs.readFileString(document), bytes);
    }).pipe(
      Effect.provide(
        Library.layer({
          home,
          roots: {
            home: root,
            configHome: root,
            overrides: { codex: [skills] },
          },
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Sync requires an explicit collision choice and keeps both Skills retained", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-collision-" }),
    );
    const home = join(root, "library");
    const skills = join(root, "skills");
    const alias = join(root, "alias");
    yield* fs.makeDirectory(skills);
    yield* fs.symlink(skills, alias);
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      for (const name of ["first", "second"]) {
        const source = join(root, name);
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(
          join(source, "SKILL.md"),
          `---\nname: review\ndescription: ${name}\n---\n${name}\n`,
        );
        const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
        if (Option.isNone(request)) return yield* Effect.die("Expected a local Skill");
        yield* library.import.collection(request.value);
      }
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Expected a Library");
      const [first, second] = snapshot.state.skills;
      if (!first || !second) return yield* Effect.die("Expected two retained Skills");
      const manifest = yield* libraryManifestFromLocalState({
        ...snapshot.state,
        enabled: [{ skill: first.skill_id }, { skill: second.skill_id }],
      });
      const before = yield* fs.readFileString(join(home, "state.json"));
      const rootFor = (destination: string) => (destination === "agents" ? alias : undefined);
      const collision = yield* resolveSyncInstalledSkillCollisions(manifest, rootFor);
      assert.lengthOf(collision.conflicts, 1);
      assert.strictEqual(collision.conflicts[0]?.resolution, "keep-enabled");
      const resolved = yield* resolveSyncInstalledSkillCollisions(manifest, rootFor, [
        first.skill_id,
      ]);
      assert.deepEqual(resolved.conflicts, []);
      assert.deepEqual(resolved.manifest.enabled, [{ skill: first.skill_id }]);
      assert.lengthOf(resolved.manifest.skills, 2);
      const invalid = yield* resolveSyncInstalledSkillCollisions(manifest, rootFor, [
        first.skill_id,
        second.skill_id,
      ]);
      assert.isTrue(invalid.invalid);
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
      assert.deepEqual(yield* fs.readDirectory(skills), []);
    }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
