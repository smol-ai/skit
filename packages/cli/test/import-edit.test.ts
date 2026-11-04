import { skitConfigurationLayer } from "@smolai/skit-core";
import { installEnabledSkills } from "./helpers/installed-skills.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash, skitLayer } from "@smolai/skit-core";
import { prepareEditImport } from "../src/workflows/library/import-edit.js";
import {
  initializeLibraryMachine,
  importCollectionIn,
  libraryHome,
  writingTo,
} from "./helpers/library-home.js";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { isolatedRoots } from "./helpers/isolated-library.js";

const installedSkillFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-projection-retain-" });
  const roots = isolatedRoots(workspace);
  const home = roots.home;
  const source = join(workspace, "source");
  const now = () => "2026-09-17T00:00:00.000Z";
  yield* initializeLibraryMachine(home);
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "original\n");
  const collection = yield* Effect.scoped(
    writingTo(
      home,
      importCollectionIn(home)({
        source: { type: "local", path: source },
        input: source,
        importedAt: now(),
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
        lockFileEntries: [],
      }),
    ),
  );
  const library = yield* libraryHome({ home });
  const configuration = skitConfigurationLayer(home);
  const initial = yield* library.durable;
  const skill = initial.skills.find(
    (candidate) => candidate.collection_id === collection.collection?.collection_id,
  );
  assert.ok(skill);
  yield* library.writeDurable({ ...initial, enabled: [{ skill: skill.skill_id }] });
  const rootByTarget = { agents: roots.codexRoot, claude: roots.claudeRoot } as const;
  for (const target of ["agents", "claude"] as const)
    yield* writingTo(
      home,
      installEnabledSkills({
        target,
        root: rootByTarget[target],
        variantsPath: join(home, "variants"),
      }),
    );
  yield* fs.writeFileString(join(roots.codexRoot, "review", "SKILL.md"), "selected change\n");
  yield* fs.writeFileString(join(roots.claudeRoot, "review", "SKILL.md"), "different change\n");

  return { fs, workspace, roots, home, source, now, skill, library, configuration };
});

it.effect(
  "retains explicitly selected installed-skill bytes and accepts only identical observations",
  () =>
    Effect.gen(function* () {
      const { fs, roots, home, source, skill, library, configuration } =
        yield* installedSkillFixture;
      const before = yield* library.durable;
      const prepared = yield* prepareEditImport(skill.name, "agents").pipe(
        Effect.provide(configuration),
      );
      const plan = prepared.preview;
      assert.strictEqual(plan.skill_id, skill.skill_id);
      assert.deepStrictEqual(
        plan.installed_skills.map((installedSkill) => [
          installedSkill.destination,
          installedSkill.agreement,
        ]),
        [
          ["agents", "selected"],
          ["claude", "different"],
        ],
      );
      assert.strictEqual(before.skills[0]?.versions.length, 1);
      assert.strictEqual(yield* fs.exists(plan.original_path), false);

      const auditPath = join(home, "audit.jsonl");
      const beforeEvents = (yield* fs.readFileString(auditPath)).trim().split("\n").length;
      const result = yield* prepared.apply().pipe(Effect.provide(configuration));
      assert.strictEqual(
        (yield* fs.readFileString(auditPath)).trim().split("\n").length,
        beforeEvents + 1,
      );
      assert.deepStrictEqual(
        result.installed_skills.map((installedSkill) => [
          installedSkill.destination,
          installedSkill.status,
        ]),
        [
          ["agents", "installed"],
          ["claude", "conflicted"],
        ],
      );
      const after = yield* library.durable;
      const imported = after.skills.find((candidate) => candidate.skill_id === skill.skill_id)!;
      assert.strictEqual(imported.versions.length, 2);
      assert.strictEqual(imported.local_version_id, result.imported_skill_version_id);
      assert.strictEqual(after.imports.at(-1)?.source_identity.kind, "local");
      assert.strictEqual(
        yield* fs.readFileString(join(roots.codexRoot, "review", "SKILL.md")),
        "selected change\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(join(roots.claudeRoot, "review", "SKILL.md")),
        "different change\n",
      );

      // Refreshing the unchanged Source records nothing, so the retained edit stays selected.
      yield* Effect.scoped(
        writingTo(
          home,
          importCollectionIn(home)({
            source: { type: "local", path: source },
            input: source,
            importedAt: "2026-09-18T00:00:00.000Z",
            skills: [
              {
                name: "review",
                sourcePath: source,
                relativePath: ".",
                currentHash: yield* deterministicTreeHash(source),
              },
            ],
            lockFileEntries: [],
          }),
        ),
      );
      const refreshed = yield* library.durable;
      assert.deepStrictEqual(refreshed.imports, after.imports);
      assert.strictEqual(
        refreshed.skills.find((candidate) => candidate.skill_id === skill.skill_id)
          ?.local_version_id,
        result.imported_skill_version_id,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["selected", "other", "Library", "home"] as const)(
  "refuses a prepared retention after %s changes without retaining or projecting",
  (change) =>
    Effect.gen(function* () {
      const f = yield* installedSkillFixture;
      const prepared = yield* prepareEditImport(f.skill.name, "agents").pipe(
        Effect.provide(f.configuration),
      );
      const otherHome = join(f.workspace, "other-library");
      const applicationLayer =
        change === "home" ? skitConfigurationLayer(otherHome) : f.configuration;
      if (change === "Library") {
        const state = yield* f.library.durable;
        yield* f.library.writeDurable({
          ...state,
          collections: state.collections.map((collection) => ({
            ...collection,
            label: "renamed",
          })),
        });
      } else if (change !== "home") {
        const root = change === "selected" ? f.roots.codexRoot : f.roots.claudeRoot;
        yield* f.fs.writeFileString(
          join(root, "review", "SKILL.md"),
          "changed after preparation\n",
        );
      }
      const before = yield* captureDisk(
        [f.home, otherHome, f.roots.codexRoot, f.roots.claudeRoot],
        { identity: true },
      );
      const failure = yield* Effect.flip(prepared.apply().pipe(Effect.provide(applicationLayer)));
      assert.strictEqual(failure._tag, "Library.StalePlan");
      yield* assertDiskUnchanged(before);
      const state = yield* f.library.durable;
      assert.strictEqual(state.skills[0]?.versions.length, 1);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("manages identical edited copies into one retained Version", () =>
  Effect.gen(function* () {
    const f = yield* installedSkillFixture;
    yield* f.fs.writeFileString(
      join(f.roots.claudeRoot, "review", "SKILL.md"),
      "selected change\n",
    );
    const before = yield* captureDisk([f.home, f.roots.codexRoot, f.roots.claudeRoot], {
      identity: true,
    });
    const prepared = yield* prepareEditImport(f.skill.name, "agents").pipe(
      Effect.provide(f.configuration),
    );
    yield* assertDiskUnchanged(before);
    assert.deepStrictEqual(
      prepared.preview.installed_skills.map((item) => item.agreement),
      ["selected", "identical"],
    );
    const result = yield* prepared.apply().pipe(Effect.provide(f.configuration));
    assert.deepStrictEqual(
      result.installed_skills.map((item) => item.status),
      ["installed", "installed"],
    );
    const state = yield* f.library.durable;
    assert.strictEqual(state.skills[0]?.versions.length, 2);
    assert.strictEqual(
      new Set(state.installed_skills.map((item) => item.skill_version_id)).size,
      1,
    );
    for (const root of [f.roots.codexRoot, f.roots.claudeRoot])
      assert.strictEqual(
        yield* f.fs.readFileString(join(root, "review", "SKILL.md")),
        "selected change\n",
      );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
