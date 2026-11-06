import { installEnabledSkills, updateInstalledSkills } from "./helpers/installed-skills.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { openSetEnabledSession } from "@smolai/skit-core/library/enable";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { setLibraryEnabled } from "./helpers/set-enabled.js";
import { isolatedRoots } from "./helpers/isolated-library.js";
import {
  initializeLibraryMachine,
  importCollectionIn,
  libraryHome,
  writingTo,
} from "./helpers/library-home.js";

const boundRawReview = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-advance-" });
  const roots = isolatedRoots(workspace);
  const home = roots.home;
  const source = join(workspace, "raw-review");
  const library = yield* libraryHome({ home });
  yield* initializeLibraryMachine(home);
  yield* fs.makeDirectory(source, { recursive: true });
  const observe = (text: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(join(source, "SKILL.md"), text);
      return yield* Effect.scoped(
        writingTo(
          home,
          importCollectionIn(home)({
            source: { type: "local", path: source },
            input: source,
            importedAt: "2026-09-16T00:00:00.000Z",
            skills: [
              {
                name: "raw-review",
                sourcePath: source,
                relativePath: "raw-review",
                currentHash: yield* deterministicTreeHash(source),
              },
            ],
            lockFileEntries: [],
          }),
        ),
      );
    });
  const first = yield* observe("first verbatim Skill\n");
  const bound = yield* library.durable;
  assert.ok(bound);
  yield* library.writeDurable({
    ...bound,
    enabled: bound.skills
      .filter((skill) => skill.collection_id === first.collection?.collection_id)
      .map((skill) => ({ skill: skill.skill_id })),
  });
  const project = writingTo(
    home,
    installEnabledSkills({
      target: "agents",
      root: roots.codexRoot,
      variantsPath: join(home, "variants"),
    }),
  );
  yield* project;
  const installed = join(roots.codexRoot, "raw-review", "SKILL.md");
  assert.strictEqual(yield* fs.readFileString(installed), "first verbatim Skill\n");
  const installedSkill = Effect.gen(function* () {
    const state = yield* library.durable;
    assert.ok(state);
    const row = state.installed_skills.find((item) => item.destination === "agents");
    assert.ok(row);
    const skill = state.skills[0];
    const view = yield* library.owned(
      openSetEnabledSession(home, { home: home, configHome: home, overrides: {} }).pipe(
        Effect.map((selection) => selection.view),
      ),
    );
    return {
      row,
      selected:
        skill === undefined
          ? undefined
          : view.membersFor(skill.collection_id).find((member) => member.id === skill.skill_id)
              ?.versionId,
    };
  });
  return { fs, home, roots, library, observe, project, installedPath: installed, installedSkill };
});

it.effect("rewrites an untouched installed skill when the selected Version advances", () =>
  Effect.gen(function* () {
    const { fs, observe, project, installedPath, installedSkill } = yield* boundRawReview;
    yield* observe("second verbatim Skill\n");
    yield* project;
    assert.strictEqual(yield* fs.readFileString(installedPath), "second verbatim Skill\n");
    const { row, selected } = yield* installedSkill;
    assert.strictEqual(row.status, "installed");
    assert.strictEqual(row.skill_version_id, selected);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "keeps a locally edited installed skill conflicted when the selected Version advances",
  () =>
    Effect.gen(function* () {
      const { fs, home, observe, project, installedPath, installedSkill } = yield* boundRawReview;
      yield* fs.writeFileString(installedPath, "my local edit\n");
      yield* observe("second verbatim Skill\n");
      yield* project;
      assert.strictEqual(yield* fs.readFileString(installedPath), "my local edit\n");
      const { row } = yield* installedSkill;
      assert.strictEqual(row.status, "conflicted");
      const variants = join(home, "variants", "agents", "raw-review");
      const [variant, ...others] = yield* fs.readDirectory(variants);
      assert.ok(variant);
      assert.deepStrictEqual(others, []);
      assert.strictEqual(
        yield* fs.readFileString(join(variants, variant, "SKILL.md")),
        "my local edit\n",
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// Before the fix, an update left untouched installed skills recorded as conflicted at the new Version.
it.effect("heals an untouched installed skill already recorded as conflicted", () =>
  Effect.gen(function* () {
    const { fs, library, observe, project, installedPath, installedSkill } = yield* boundRawReview;
    yield* observe("second verbatim Skill\n");
    const state = yield* library.durable;
    assert.ok(state);
    const view = yield* library.owned(
      openSetEnabledSession(library.home, {
        home: library.home,
        configHome: library.home,
        overrides: {},
      }).pipe(Effect.map((selection) => selection.view)),
    );
    const selected = view.collections
      .flatMap((collection) => collection.members)
      .find((member) => member.id === state.skills[0]?.skill_id)?.versionId;
    assert.ok(selected);
    yield* library.writeDurable({
      ...state,
      // Untouched on disk, so the folder still holds the hash SKIT wrote.
      installed_skills: state.installed_skills.map((row) => ({
        ...row,
        skill_version_id: selected,
        status: "conflicted" as const,
        current_hash: row.expected_hash,
      })),
    });
    yield* project;
    assert.strictEqual(yield* fs.readFileString(installedPath), "second verbatim Skill\n");
    const { row } = yield* installedSkill;
    assert.strictEqual(row.status, "installed");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("re-enabling an unchanged Binding reconciles a changed global root", () =>
  Effect.gen(function* () {
    const { fs, home, roots, library, installedPath } = yield* boundRawReview;
    const newRoot = join(home, "relocated", "skills");
    const before = yield* library.durable;
    const skillId = before.skills[0]?.skill_id;
    assert.ok(skillId);
    const changed = yield* writingTo(
      home,
      setLibraryEnabled({
        query: skillId,
        all: false,
        roots: { home, configHome: join(home, "config"), overrides: { codex: [newRoot] } },
        variantsPath: join(home, "variants"),
        invocation: {
          scope: { kind: "global" },
          enabled: true,
          dryRun: false,
        },
      }),
    );
    assert.strictEqual(changed.kind, "applied");
    assert.strictEqual(changed.value.changed, false);
    assert.strictEqual(yield* fs.exists(installedPath), false);
    assert.strictEqual(
      yield* fs.readFileString(join(newRoot, "raw-review", "SKILL.md")),
      "first verbatim Skill\n",
    );
    const after = yield* library.durable;
    assert.strictEqual(
      after.installed_skills.filter((row) => row.root === roots.codexRoot).length,
      0,
    );
    assert.strictEqual(after.installed_skills.filter((row) => row.root === newRoot).length, 1);
    assert.deepStrictEqual(after.enabled, before.enabled);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

for (const followedCollection of [false, true])
  it.effect(
    `explicit enable recreates only the selected installed skill (followed Collection=${followedCollection})`,
    () =>
      Effect.gen(function* () {
        const { fs, home, roots, library, project, installedPath } = yield* boundRawReview;
        const load = library.durable;
        const otherSource = join(home, "other-source");
        yield* fs.makeDirectory(otherSource);
        yield* fs.writeFileString(join(otherSource, "SKILL.md"), "other Skill bytes\n");
        const other = yield* writingTo(
          home,
          importCollectionIn(home)({
            source: { type: "local", path: otherSource },
            input: otherSource,
            importedAt: "2026-09-16T00:00:00.000Z",
            skills: [
              {
                name: "other",
                sourcePath: otherSource,
                relativePath: ".",
                currentHash: yield* deterministicTreeHash(otherSource),
              },
            ],
            lockFileEntries: [],
          }),
        );
        const otherId = other.skills[0]?.skill_id;
        assert.ok(otherId);
        const withOther = yield* load;
        const selectedSkill = withOther.skills.find((skill) => skill.name === "raw-review");
        assert.ok(selectedSkill);
        const skillId = selectedSkill.skill_id;
        yield* library.writeDurable({
          ...withOther,
          enabled: [
            ...(followedCollection
              ? [{ collection: selectedSkill.collection_id }]
              : withOther.enabled),
            { skill: otherId },
          ],
        });
        yield* project;
        yield* fs.remove(join(roots.codexRoot, "other"), { recursive: true });
        yield* fs.remove(join(roots.codexRoot, "raw-review"), { recursive: true });
        yield* writingTo(
          home,
          Effect.gen(function* () {
            const owner = yield* Library.Service;
            const plan = yield* owner.plan(
              { _tag: "RefreshInventory", roots: [] },
              { base: yield* owner.read },
            );
            return yield* owner.apply({ _tag: "Apply", plan: plan });
          }),
        );
        const suppressed = yield* load;
        const suppressedRow = suppressed.installed_skills.find(
          (row) => row.skill_id === skillId && row.destination === "agents",
        );
        assert.strictEqual(suppressedRow?.status, "suppressed");
        yield* project;
        assert.strictEqual(yield* fs.exists(installedPath), false);
        const before = yield* load;

        const enable = (dryRun: boolean) =>
          writingTo(
            home,
            setLibraryEnabled({
              query: skillId,
              all: false,
              roots: {
                home,
                configHome: join(home, "config"),
                overrides: { codex: [roots.codexRoot] },
              },
              variantsPath: join(home, "variants"),
              invocation: {
                scope: { kind: "global" },
                enabled: true,
                dryRun,
              },
            }),
          );
        const preview = yield* enable(true);
        assert.strictEqual(preview.kind, "plan");
        assert.strictEqual(yield* fs.exists(installedPath), false);
        assert.deepStrictEqual(yield* load, before);
        const applied = yield* enable(false);
        assert.strictEqual(applied.kind, "applied");
        assert.strictEqual(applied.value.changed, false);
        assert.strictEqual(yield* fs.readFileString(installedPath), "first verbatim Skill\n");
        const after = yield* load;
        const restored = after.installed_skills.find(
          (row) => row.skill_id === skillId && row.destination === "agents",
        );
        assert.strictEqual(restored?.status, "installed");
        assert.deepStrictEqual(after.enabled, before.enabled);
        assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "other")), false);
        assert.strictEqual(
          after.installed_skills.find((row) => row.skill_id === otherId)?.status,
          "suppressed",
        );
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

it.effect(
  "reconciling without routing keeps intact copies rather than treating them as inactive",
  () =>
    Effect.gen(function* () {
      const { fs, home, installedPath, installedSkill } = yield* boundRawReview;
      const reconciled = yield* writingTo(
        home,
        updateInstalledSkills({ variantsPath: join(home, "variants") }),
      );
      assert.strictEqual(reconciled.uninstalled, 0);
      assert.strictEqual(yield* fs.readFileString(installedPath), "first verbatim Skill\n");
      assert.strictEqual((yield* installedSkill).row.status, "installed");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
