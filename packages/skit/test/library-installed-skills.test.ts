import { openLibrary, inLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import { systemError } from "effect/PlatformError";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { makeSkillVersionId, migratedMachineId } from "../src/library/entity-ids.js";
import { currentSkillVersion, versionBacking } from "../src/library/library-contracts.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import {
  installEnabledSkills,
  planUpdate,
  removeCollection,
  uninstallCopies,
  uninstallLeftovers,
} from "./helpers/library.js";

import type { LibraryState } from "../src/library/library-state.js";
import type { InstalledSkill } from "../src/library/device-state.js";
import { LibraryWriter, loadLibrary } from "../src/library/store/library-store.js";

import { skitLayer } from "../src/platform/layer.js";
import * as Library from "../src/library/library.js";
import { losslessTree, installedSkillStagingDirectory } from "../src/installed-skills/backups.js";
import { inspectOwnershipMarker } from "../src/installed-skills/files.js";

const machineId = migratedMachineId(
  "019950c0-4c00-7000-8000-000000000001",
  "library-projection-test",
);

/** A retained local Collection with one Skill globally bound to codex, not yet installed. */
const boundCollectionWith = (second = false, emptyDirectories: readonly string[] = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-project-" });
    const home = join(workspace, "home");
    const source = join(workspace, "source");
    const targetRoot = join(workspace, "harness", "skills");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.makeDirectory(targetRoot, { recursive: true });
    const firstSource = second ? join(source, "review") : source;
    yield* fs.makeDirectory(firstSource, { recursive: true });
    yield* fs.writeFileString(join(firstSource, "SKILL.md"), "raw Skill bytes\n");
    for (const directory of emptyDirectories) yield* fs.makeDirectory(join(firstSource, directory));
    const secondSource = join(source, "second");
    if (second) {
      yield* fs.makeDirectory(secondSource);
      yield* fs.writeFileString(join(secondSource, "SKILL.md"), "second Skill bytes\n");
    }
    const imported = yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* openLibrary(home);
        return yield* owner.import.collection({
          machineId,
          source: { type: "local", path: source },
          input: source,
          importedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: firstSource,
              relativePath: second ? "review" : ".",
              currentHash: yield* deterministicTreeHash(firstSource),
            },
            ...(second
              ? [
                  {
                    name: "second",
                    sourcePath: secondSource,
                    relativePath: "second",
                    currentHash: yield* deterministicTreeHash(secondSource),
                  },
                ]
              : []),
          ],
          lockFileEntries: [],
        });
      }),
    );
    const initial = yield* loadLibrary(home);
    const skillId = imported.skills[0]?.skill_id;
    assert.ok(skillId);
    yield* inLibrary(home)(
      Effect.flatMap(LibraryWriter, (writer) =>
        writer.save(
          {
            ...initial,
            enabled: imported.skills.map((skill) => ({ skill: skill.skill_id })),
          },
          initial,
        ),
      ),
    );

    return { fs, home, targetRoot };
  });

const boundCollection = boundCollectionWith();

/** A released pending-backup layout left by a killed process, independent of today's writer. */
const interruptedBackup = Effect.fn("Test.interruptedBackup")(function* (
  copy: Pick<InstalledSkill, "root" | "path" | "installed_skill_id">,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = join(dirname(copy.root), ".skit-backups");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(join(directory, ".gitignore"), "*\n");
  const saved = join(
    directory,
    `pending-${copy.installed_skill_id}-2026-11-05T00-00-00.000Z-replace-interrupted`,
  );
  yield* fs.rename(copy.path, saved);
  return saved;
});

it.effect(
  "projects bound retained bytes, preserves a foreign target, and retires unbound ownership",
  () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot } = yield* boundCollection;

      const target = join(targetRoot, "review");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(join(target, "SKILL.md"), "foreign\n");
      const project = installEnabledSkills({
        home,
        target: "agents",
        root: targetRoot,
        variantsPath: join(home, "variants"),
      });
      assert.strictEqual(
        Result.isSuccess(yield* inLibrary(home)(project).pipe(Effect.result)),
        true,
      );
      assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "foreign\n");
      const conflicted = yield* loadLibrary(home);
      assert.strictEqual(conflicted.installed_skills[0]?.status, "conflicted");

      yield* fs.remove(target, { recursive: true });
      yield* inLibrary(home)(project);
      assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
      assert.strictEqual(yield* fs.exists(join(target, ".skit-ownership.json")), true);
      const installed = yield* loadLibrary(home);
      assert.strictEqual(installed.installed_skills[0]?.status, "installed");
      const markerV2 = yield* inspectOwnershipMarker(target);
      assert.strictEqual(markerV2.kind, "valid");
      if (markerV2.kind === "valid") assert.strictEqual(markerV2.marker.schemaVersion, 5);

      yield* inLibrary(home)(
        Effect.flatMap(LibraryWriter, (writer) =>
          writer.save(
            {
              ...installed,
              enabled: [],
            },
            installed,
          ),
        ),
      );
      const retire = uninstallLeftovers({
        home,
        variantsPath: join(home, "variants"),
        activeTargets: ["agents", "claude"],
      });
      assert.strictEqual(yield* inLibrary(home)(retire), 1);
      assert.strictEqual(yield* fs.exists(target), false);
      const retired = yield* loadLibrary(home);
      assert.deepStrictEqual(retired.installed_skills, []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("records no installed copy when its written bytes fail verification", () =>
  Effect.gen(function* () {
    const { home, targetRoot } = yield* boundCollection;
    const diverged = divergingOn(join(targetRoot, "review"));
    const installed = yield* installEnabledSkills({
      home,
      target: "agents",
      root: targetRoot,
      variantsPath: join(home, "variants"),
    })
      .pipe(Effect.provide(diverged))
      .pipe(Effect.result);
    assert.strictEqual(Result.isFailure(installed), true);
    if (Result.isFailure(installed))
      assert.strictEqual(installed.failure._tag, "InstalledSkillFailure");
    const after = yield* loadLibrary(home);
    assert.deepStrictEqual(after.installed_skills, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refreshes an equivalent Version handle only on an intact owned installed skill", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot } = yield* boundCollection;
    const target = join(targetRoot, "review");
    const project = installEnabledSkills({
      home,
      target: "agents",
      root: targetRoot,
      variantsPath: join(home, "variants"),
    });
    yield* inLibrary(home)(project);
    const before = yield* loadLibrary(home);
    const hash = yield* deterministicTreeHash(target);
    const newId = makeSkillVersionId();
    yield* inLibrary(home)(
      Effect.flatMap(LibraryWriter, (writer) =>
        writer.save(
          {
            ...before,
            skills: before.skills.map((skill) => ({
              ...skill,
              versions: skill.versions.map((version) => ({ ...version, skill_version_id: newId })),
            })),
            installed_skills: before.installed_skills.map((installedSkill) => ({
              ...installedSkill,
              skill_version_id: newId,
            })),
          },
          before,
        ),
      ),
    );
    yield* inLibrary(home)(project);
    const marker = yield* inspectOwnershipMarker(target);
    assert.strictEqual(marker.kind, "valid");
    if (marker.kind === "valid") {
      assert.strictEqual(marker.marker.skill_version_id, newId);
      assert.strictEqual(
        marker.marker.installed_skill_id,
        before.installed_skills[0]?.installed_skill_id,
      );
    }
    assert.strictEqual(yield* deterministicTreeHash(target), hash);
    assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
    // User edits still block metadata refresh and materialization.
    const editedId = makeSkillVersionId();
    const installed = yield* loadLibrary(home);
    yield* inLibrary(home)(
      Effect.flatMap(LibraryWriter, (writer) =>
        writer.save(
          {
            ...installed,
            skills: installed.skills.map((skill) => ({
              ...skill,
              versions: skill.versions.map((version) => ({
                ...version,
                skill_version_id: editedId,
              })),
            })),
            installed_skills: installed.installed_skills.map((installedSkill) => ({
              ...installedSkill,
              skill_version_id: editedId,
            })),
          },
          installed,
        ),
      ),
    );
    yield* fs.writeFileString(join(target, "SKILL.md"), "user edited bytes\n");
    yield* inLibrary(home)(project);
    const editedMarker = yield* inspectOwnershipMarker(target);
    assert.strictEqual(editedMarker.kind, "valid");
    if (editedMarker.kind === "valid")
      assert.strictEqual(editedMarker.marker.skill_version_id, newId);
    assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "user edited bytes\n");
    const conflicted = yield* loadLibrary(home);
    assert.strictEqual(conflicted.installed_skills[0]?.status, "conflicted");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retires intact former roots when a globally bound Skill moves to a new root", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot } = yield* boundCollection;
    const newRoot = join(home, "new-harness", "skills");
    const project = (root: string) =>
      installEnabledSkills({ home, target: "agents", root, variantsPath: join(home, "variants") });
    yield* project(targetRoot);
    yield* project(newRoot);
    assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), false);
    assert.strictEqual(
      yield* fs.readFileString(join(newRoot, "review", "SKILL.md")),
      "raw Skill bytes\n",
    );
    const load = loadLibrary(home);
    const after = yield* load;
    assert.strictEqual(after.installed_skills.length, 1);
    assert.strictEqual(after.installed_skills[0]?.root, newRoot);
    assert.strictEqual(after.installed_skills[0]?.status, "installed");
    yield* project(newRoot);
    assert.strictEqual((yield* load).installed_skills.length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const changed of ["bytes", "ownership"] as const)
  it.effect(
    `refuses directory relocation when the former installed skill's ${changed} changed`,
    () =>
      Effect.gen(function* () {
        const { fs, home, targetRoot } = yield* boundCollection;
        const newRoot = join(home, "new-harness", "skills");
        const project = (root: string) =>
          installEnabledSkills({
            home,
            target: "agents",
            root,
            variantsPath: join(home, "variants"),
          });
        yield* project(targetRoot);
        const path = join(targetRoot, "review");
        if (changed === "bytes")
          yield* fs.writeFileString(join(path, "SKILL.md"), "my local edits\n");
        else yield* fs.remove(join(path, ".skit-ownership.json"));
        const load = loadLibrary(home);
        const before = yield* load;
        const result = yield* project(newRoot).pipe(Effect.result);
        assert.strictEqual(Result.isFailure(result), true);
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure._tag, "UninstallConflict");
          if (result.failure._tag === "UninstallConflict")
            assert.include(result.failure.detail, path);
        }
        assert.strictEqual(yield* fs.exists(join(newRoot, "review")), false);
        assert.strictEqual(
          yield* fs.readFileString(join(path, "SKILL.md")),
          changed === "bytes" ? "my local edits\n" : "raw Skill bytes\n",
        );
        assert.deepStrictEqual(yield* load, before);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

for (const alias of [false, true])
  it.effect(
    `keeps repository-scoped and other-target installations during a global root change (alias=${alias})`,
    () =>
      Effect.gen(function* () {
        const { fs, home, targetRoot } = yield* boundCollection;
        const repository = join(home, "repository");
        const repositoryRoot = join(repository, ".agents", "skills");
        const enabledRoot = alias ? join(home, "repository-alias") : repository;
        if (alias) {
          yield* fs.makeDirectory(repository, { recursive: true });
          yield* fs.symlink(repository, enabledRoot);
        }
        const otherRoot = join(home, "claude", "skills");
        const newRoot = join(home, "new-harness", "skills");
        const load = loadLibrary(home);
        const state = yield* load;
        const enabled = state.enabled;
        assert.ok(enabled.length);
        yield* inLibrary(home)(
          Effect.flatMap(LibraryWriter, (writer) =>
            writer.save(
              {
                ...state,
                repositories: [{ root: enabledRoot, enabled }],
              },
              state,
            ),
          ),
        );
        const project = (
          target: "agents" | "claude",
          root: string,
          scope: { kind: "global" } | { kind: "repository"; root: string } = { kind: "global" },
        ) =>
          installEnabledSkills({ home, target, root, scope, variantsPath: join(home, "variants") });
        yield* project("agents", targetRoot);
        yield* project("agents", repositoryRoot, { kind: "repository", root: enabledRoot });
        yield* project("claude", otherRoot);
        yield* project("agents", newRoot);
        assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), false);
        for (const root of [
          repositoryRoot,
          join(enabledRoot, ".claude", "skills"),
          otherRoot,
          newRoot,
        ])
          assert.strictEqual(
            yield* fs.readFileString(join(root, "review", "SKILL.md")),
            "raw Skill bytes\n",
          );
        const after = yield* load;
        assert.deepStrictEqual(
          (yield* Effect.forEach(after.installed_skills, (copy) => fs.realPath(copy.root))).sort(),
          (yield* Effect.forEach(
            [repositoryRoot, join(enabledRoot, ".claude", "skills"), otherRoot, newRoot],
            (root) => fs.realPath(root),
          )).sort(),
        );
        assert.deepStrictEqual(after.repositories, [{ root: enabledRoot, enabled }]);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "keeps the old working installation when the new root is occupied by a foreign copy",
  () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot } = yield* boundCollection;
      const newRoot = join(home, "new-harness", "skills");
      const newPath = join(newRoot, "review");
      const project = (root: string) =>
        installEnabledSkills({
          home,
          target: "agents",
          root,
          variantsPath: join(home, "variants"),
        });
      yield* project(targetRoot);
      yield* fs.makeDirectory(newPath, { recursive: true });
      yield* fs.writeFileString(join(newPath, "SKILL.md"), "foreign Skill\n");
      yield* project(newRoot);
      assert.strictEqual(yield* fs.readFileString(join(newPath, "SKILL.md")), "foreign Skill\n");
      assert.strictEqual(
        yield* fs.readFileString(join(targetRoot, "review", "SKILL.md")),
        "raw Skill bytes\n",
      );
      const blocked = yield* loadLibrary(home);
      assert.strictEqual(
        blocked.installed_skills.find((installedSkill) => installedSkill.root === newRoot)?.status,
        "conflicted",
      );
      yield* fs.remove(newPath, { recursive: true });
      yield* project(newRoot);
      assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), false);
      assert.strictEqual(yield* fs.readFileString(join(newPath, "SKILL.md")), "raw Skill bytes\n");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("treats symlink aliases of the same root as one target without retiring its bytes", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot } = yield* boundCollection;
    const alias = join(home, "root-alias");
    const project = (root: string) =>
      installEnabledSkills({ home, target: "agents", root, variantsPath: join(home, "variants") });
    yield* project(targetRoot);
    yield* fs.symlink(targetRoot, alias);
    yield* project(alias);
    assert.strictEqual(
      yield* fs.readFileString(join(targetRoot, "review", "SKILL.md")),
      "raw Skill bytes\n",
    );
    const after = yield* loadLibrary(home);
    assert.strictEqual(after.installed_skills.length, 1);
    assert.strictEqual(after.installed_skills[0]?.root, alias);
    assert.strictEqual(after.installed_skills[0]?.status, "installed");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("checks every retained input before relocating any installed copy", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot } = yield* boundCollectionWith(true);
    const project = (root: string) =>
      installEnabledSkills({ home, target: "agents", root, variantsPath: join(home, "variants") });
    yield* project(targetRoot);
    const before = yield* loadLibrary(home);
    const second = before.skills.find((skill) => skill.name === "second");
    assert.ok(second);
    const version = currentSkillVersion(before, second);
    assert.ok(version);
    const backing = versionBacking(before, second, version);
    assert.ok(backing);
    yield* fs.writeFileString(
      join(
        collectionVersionPath(join(home, "originals"), backing.copy.hash),
        backing.member.source_path,
        "SKILL.md",
      ),
      "tampered retained bytes\n",
    );
    const newRoot = join(home, "new-root");
    const result = yield* project(newRoot).pipe(Effect.result);
    assert.strictEqual(Result.isFailure(result), true);
    if (Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "Library.InstalledSkillInvalid");
    assert.strictEqual(
      yield* fs.readFileString(join(targetRoot, "review", "SKILL.md")),
      "raw Skill bytes\n",
    );
    assert.strictEqual(
      yield* fs.readFileString(join(targetRoot, "second", "SKILL.md")),
      "second Skill bytes\n",
    );
    const after = yield* loadLibrary(home);
    // The complete input set is checked before relocation starts. The prior copies stay live.
    assert.deepStrictEqual(after.installed_skills, before.installed_skills);
    assert.isFalse(yield* fs.exists(join(newRoot, "review")));
    assert.deepStrictEqual(withoutOperations(after), withoutOperations(before));
    assert.strictEqual(after.operations.at(-1)?._tag, "Stopped");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retires a bound Skill's copies at a target that is no longer active", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot } = yield* boundCollection;
    const claudeRoot = join(home, "claude", "skills");
    for (const [target, root] of [
      ["agents", targetRoot],
      ["claude", claudeRoot],
    ] as const)
      yield* installEnabledSkills({ home, target, root, variantsPath: join(home, "variants") });
    const retired = yield* uninstallLeftovers({
      home,
      variantsPath: join(home, "variants"),
      activeTargets: ["agents"],
    });
    assert.strictEqual(retired, 1);
    assert.strictEqual(yield* fs.exists(join(claudeRoot, "review")), false);
    assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), true);
    const after = yield* loadLibrary(home);
    assert.deepStrictEqual(
      after.installed_skills.map((installedSkill) => installedSkill.destination),
      ["agents"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps and reports an edited copy at an inactive target without blocking", () =>
  Effect.gen(function* () {
    const { fs, home } = yield* boundCollection;
    const claudeRoot = join(home, "claude", "skills");
    yield* installEnabledSkills({
      home,
      target: "claude",
      root: claudeRoot,
      variantsPath: join(home, "variants"),
    });
    const edited = join(claudeRoot, "review", "SKILL.md");
    yield* fs.writeFileString(edited, "my edit\n");
    const retire = uninstallLeftovers({
      home,
      variantsPath: join(home, "variants"),
      activeTargets: ["agents"],
    });
    const load = loadLibrary(home);

    assert.strictEqual(yield* retire, 0);
    assert.strictEqual(yield* fs.readFileString(edited), "my edit\n");
    assert.deepStrictEqual(
      (yield* load).installed_skills.map((installedSkill) => [
        installedSkill.destination,
        installedSkill.status,
      ]),
      [
        ["agents", "installed"],
        ["claude", "conflicted"],
      ],
    );

    const agents = (yield* load).installed_skills.find((copy) => copy.destination === "agents");
    assert.ok(agents);
    // Removing the inactive copy releases its record while the enabled agents copy stays installed.
    yield* fs.remove(join(claudeRoot, "review"), { recursive: true });
    yield* retire;
    assert.deepStrictEqual((yield* load).installed_skills, [agents]);
    assert.strictEqual(
      yield* fs.readFileString(join(agents.path, "SKILL.md")),
      "raw Skill bytes\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** A projectable Collection with the workflows and observations the backup tests drive. */
const installedSkillFixture = (second = false, emptyDirectories: readonly string[] = []) =>
  Effect.gen(function* () {
    const bound = yield* boundCollectionWith(second, emptyDirectories);
    const { home, targetRoot } = bound;
    const variantsPath = join(home, "variants");
    const load = loadLibrary(home);
    const edit = (change: (state: LibraryState) => LibraryState) =>
      inLibrary(home)(
        Effect.flatMap(LibraryWriter, (writer) =>
          Effect.flatMap(loadLibrary(home), (state) => writer.save(change(state), state)),
        ),
      );
    const project = (
      options: Omit<
        Parameters<typeof installEnabledSkills>[0],
        "home" | "target" | "variantsPath"
      > = {
        root: targetRoot,
      },
    ) => installEnabledSkills({ home, target: "agents", variantsPath, ...options });
    const retire = uninstallLeftovers({ home, variantsPath, activeTargets: ["agents"] }).pipe(
      Effect.asVoid,
    );
    const remove = (state: LibraryState) =>
      removeCollection(home, state, state.collections[0]!.collection_id).pipe(Effect.asVoid);
    const refresh = Effect.gen(function* () {
      const library = yield* Library.Service;
      const plan = yield* library.plan(
        { _tag: "RefreshInventory", roots: [{ harness: "codex", root: targetRoot }] },
        { base: yield* library.read },
      );
      return (yield* library.apply({ _tag: "Apply", plan: plan })).result;
    }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));

    return { ...bound, variantsPath, load, edit, project, retire, remove, refresh };
  });

/** Every backup beside a real skills directory, as `pending`/`kept` and its path. */
const backupsBeside = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const backups = join(dirname(yield* fs.realPath(root)), ".skit-backups");
    if (!(yield* fs.exists(backups))) return [];
    return (yield* fs.readDirectory(backups))
      .filter((name) => name !== ".gitignore")
      .map((name) => ({ disposition: name.split("-")[0]!, path: join(backups, name) }));
  });

const explicitPolicies = (state: LibraryState): LibraryState => ({
  ...state,
  invocation_policies: Object.fromEntries(
    state.skills.map((skill) => [skill.skill_id, "explicit" as const]),
  ),
});

const unbound = (state: LibraryState): LibraryState => ({ ...state, enabled: [] });

/** Corrupt the real successor immediately after its rename, before installer verification. */
const divergingOn = (path: string) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          yield* fs.rename(from, to);
          if (to === path)
            yield* fs.writeFileString(join(path, "SKILL.md"), "Divergent successor bytes\n");
        }),
    })),
  );

const withoutOperations = ({ operations: _operations, ...state }: LibraryState) => state;

it.effect(
  "manages equal content in place, keeping its excluded entries and empty directories",
  () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, project } = yield* installedSkillFixture();
      const target = join(targetRoot, "review");
      yield* fs.makeDirectory(join(target, "notes", ".git"), { recursive: true });
      yield* fs.makeDirectory(join(target, "empty"));
      yield* fs.writeFileString(join(target, "notes", ".git", "HEAD"), "ref: refs/heads/main\n");
      yield* fs.writeFileString(join(target, "SKILL.md"), "raw Skill bytes\n");
      yield* project({
        root: targetRoot,
        manage: { path: target, currentHash: yield* deterministicTreeHash(target) },
      });
      assert.strictEqual(
        yield* fs.readFileString(join(target, "notes", ".git", "HEAD")),
        "ref: refs/heads/main\n",
      );
      assert.strictEqual((yield* fs.stat(join(target, "empty"))).type, "Directory");
      assert.strictEqual((yield* inspectOwnershipMarker(target)).kind, "valid");
      assert.strictEqual((yield* load).installed_skills[0]?.status, "installed");
      assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "keeps the replaced copy in a pending backup when its install fails, then converges",
  () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, edit, project } = yield* installedSkillFixture();
      const target = join(targetRoot, "review");
      yield* project();
      const original = yield* deterministicTreeHash(target);
      yield* edit(explicitPolicies);

      const failed = yield* project().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === target
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                  }),
                )
              : fs.rename(from, to),
        }),
        Effect.result,
      );
      assert.strictEqual(Result.isFailure(failed), true);
      assert.strictEqual(yield* fs.exists(target), false);
      const backups = yield* backupsBeside(targetRoot);
      assert.deepStrictEqual(
        backups.map((backup) => backup.disposition),
        ["pending"],
      );
      assert.strictEqual(yield* deterministicTreeHash(backups[0]!.path), original);
      assert.strictEqual((yield* load).installed_skills[0]?.status, "pending");

      yield* project();
      assert.notStrictEqual(yield* deterministicTreeHash(target), original);
      assert.strictEqual((yield* load).installed_skills[0]?.status, "installed");
      // The retained original and the recorded declared policy restage the original exactly.
      assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const content of ["reproducible", "git-bytes", "empty-directory"] as const)
  for (const action of ["replace", "retire"] as const)
    it.effect(`${action} keeps a backup only of a copy SKIT cannot restage (${content})`, () =>
      Effect.gen(function* () {
        const { fs, targetRoot, edit, project, retire } = yield* installedSkillFixture();
        const target = join(targetRoot, "review");
        yield* project();
        if (content === "git-bytes") {
          yield* fs.makeDirectory(join(target, "notes", ".git"), { recursive: true });
          yield* fs.writeFileString(join(target, "notes", ".git", "config"), "[core]\n");
        }
        if (content === "empty-directory") yield* fs.makeDirectory(join(target, "my-notes"));
        if (action === "replace") {
          yield* edit(explicitPolicies);
          yield* project();
        } else {
          yield* edit(unbound);
          yield* retire;
        }
        const backups = yield* backupsBeside(targetRoot);
        assert.deepStrictEqual(
          backups.map((backup) => backup.disposition),
          content === "reproducible" ? [] : ["kept"],
        );
        if (content === "git-bytes") {
          assert.strictEqual(
            yield* fs.readFileString(join(backups[0]!.path, "notes", ".git", "config")),
            "[core]\n",
          );
          // Backups beside a repository's root must never be committed with it.
          const repository = dirname(dirname(targetRoot));
          execFileSync("git", ["init", "--quiet", repository]);
          execFileSync("git", [
            "-C",
            repository,
            "check-ignore",
            "--quiet",
            join(backups[0]!.path, "SKILL.md"),
          ]);
        }
        if (content === "empty-directory")
          assert.deepStrictEqual(yield* fs.readDirectory(join(backups[0]!.path, "my-notes")), []);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );

for (const change of ["entry-name", "link-target", "root-mode"] as const)
  it.effect(`retire keeps a backup whose ${change} differs from what SKIT wrote`, () =>
    Effect.gen(function* () {
      const { fs, targetRoot, edit, project, retire } = yield* installedSkillFixture(false, [
        "a",
        "b",
      ]);
      const target = join(targetRoot, "review");
      yield* project();
      if (change === "entry-name") {
        // One directory named to read like the two it replaces, were entries joined as text.
        const mode = ((yield* fs.stat(join(target, "a"))).mode & 0o7777).toString(8);
        yield* fs.remove(join(target, "a"), { recursive: true });
        yield* fs.remove(join(target, "b"), { recursive: true });
        yield* fs.makeDirectory(join(target, `a\ndirectory ${mode} b`));
      }
      if (change === "link-target")
        yield* fs.symlink(`SKILL.md\nfile 644 SKILL.md`, join(target, ".DS_Store"));
      if (change === "root-mode") yield* fs.chmod(target, 0o700);
      yield* edit(unbound);
      yield* retire;
      assert.deepStrictEqual(
        (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
        ["kept"],
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("retire discards a reproducible copy with empty directories", () =>
  Effect.gen(function* () {
    const { targetRoot, edit, project, retire } = yield* installedSkillFixture(false, ["a", "b"]);
    yield* project();
    yield* edit(unbound);
    yield* retire;
    assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const original of ["intact", "missing", "corrupt"] as const)
  for (const action of ["replace", "retire", "remove"] as const)
    it.effect(
      `${action} discards a backup only with an intact retained original (${original})`,
      () =>
        Effect.gen(function* () {
          const { fs, home, targetRoot, load, edit, project, retire, remove } =
            yield* installedSkillFixture();
          const target = join(targetRoot, "review");
          yield* project();
          let backed = (yield* load).collection_versions[0]!.hash;
          let bytes = "raw Skill bytes\n";
          if (action === "replace") {
            // Install a second retained Version, then select the first again so the copy of the
            // second is the one replaced.
            const first = (yield* load).installed_skills[0]!;
            bytes = "second Version bytes\n";
            yield* fs.writeFileString(join(target, "SKILL.md"), bytes);
            const second = yield* Effect.gen(function* () {
              const owner = yield* openLibrary(home);
              return yield* owner.import.edit({
                skillId: first.skill_id,
                installedSkillId: first.installed_skill_id,
                path: target,
                currentHash: yield* deterministicTreeHash(target),
                importedAt: "2026-09-17T00:00:00.000Z",
              });
            });
            backed = second.snapshotDigest;
            yield* fs.remove(target, { recursive: true });
            yield* project({ root: targetRoot, restoreNativeDeletedSkills: [first.skill_id] });
            assert.strictEqual(
              (yield* load).installed_skills[0]?.skill_version_id,
              second.skillVersionId,
            );
            yield* edit((state) => ({
              ...state,
              skills: state.skills.map((skill) => ({
                ...skill,
                local_version_id: first.skill_version_id,
              })),
            }));
          }
          const imported = collectionVersionPath(join(home, "originals"), backed);
          if (original === "missing") yield* fs.remove(imported, { recursive: true });
          if (original === "corrupt")
            yield* fs.writeFileString(join(imported, "SKILL.md"), "tampered retained bytes\n");

          if (action === "replace") yield* project();
          if (action === "retire") {
            yield* edit(unbound);
            yield* retire;
          }
          if (action === "remove") yield* remove(yield* load);
          const backups = yield* backupsBeside(targetRoot);
          assert.deepStrictEqual(
            backups.map((backup) => backup.disposition),
            original === "intact" ? [] : ["kept"],
          );
          if (original !== "intact")
            assert.strictEqual(yield* fs.readFileString(join(backups[0]!.path, "SKILL.md")), bytes);
        }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );

for (const batch of ["uninstall", "remove-collection"] as const)
  it.effect(
    `records the copies a failed ${batch} batch already retired, so none reads as a native deletion`,
    () =>
      Effect.gen(function* () {
        const { fs, load, edit, project, retire, remove, refresh } =
          yield* installedSkillFixture(true);
        yield* project();
        const state = yield* load;
        const [first, second] = state.installed_skills;
        assert.ok(first && second);
        if (batch === "uninstall") yield* edit(unbound);
        // The second copy cannot be moved aside, after the first already was.
        const failed = yield* (batch === "uninstall" ? retire : remove(state)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              from === second.path
                ? Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: from,
                    }),
                  )
                : fs.rename(from, to),
          }),
          Effect.result,
        );
        assert.strictEqual(Result.isFailure(failed), true);
        // A failed removal keeps the Collection; only the copy it moved aside is recorded.
        assert.deepStrictEqual((yield* load).collections, state.collections);
        assert.strictEqual(yield* fs.exists(first.path), false);
        assert.strictEqual(yield* fs.exists(second.path), true);

        yield* refresh;
        assert.deepStrictEqual(
          (yield* load).installed_skills.map((installedSkill) => [
            installedSkill.installed_skill_id,
            installedSkill.status,
          ]),
          [
            [first.installed_skill_id, "pending"],
            [second.installed_skill_id, "installed"],
          ],
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "reads a copy moved to a pending backup as SKIT's absence, and a deletion as native",
  () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, project, refresh } = yield* installedSkillFixture();
      yield* project();
      const installedSkill = (yield* load).installed_skills[0];
      assert.ok(installedSkill);
      // A process killed after moving the copy aside, before publishing what it meant to do.
      yield* interruptedBackup(installedSkill);
      yield* refresh;
      assert.strictEqual((yield* load).installed_skills[0]?.status, "pending");
      yield* project();
      assert.strictEqual((yield* load).installed_skills[0]?.status, "installed");
      assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);

      yield* fs.remove(installedSkill.path, { recursive: true });
      yield* refresh;
      const deleted = (yield* load).installed_skills[0];
      assert.strictEqual(deleted?.status, "suppressed");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const stale of ["observed-successor", "settle-failure"] as const)
  it.effect(`a stale pending backup cannot hide a later native deletion (${stale})`, () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, edit, project, refresh } = yield* installedSkillFixture();
      yield* project();
      const installedSkill = (yield* load).installed_skills[0];
      assert.ok(installedSkill);
      if (stale === "observed-successor") {
        // Killed after installing a successor but before publishing it; inventory then verifies it.
        const backup = yield* interruptedBackup(installedSkill);
        yield* fs.copy(backup, installedSkill.path);
        yield* refresh;
      } else {
        yield* edit(explicitPolicies);
        yield* project().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (path, options) =>
              path.includes(".skit-backups")
                ? Effect.fail(systemError({ _tag: "Busy", module: "FileSystem", method: "remove" }))
                : fs.remove(path, options),
          }),
        );
      }
      assert.strictEqual(
        (yield* backupsBeside(targetRoot)).length,
        1,
        "the superseded original is still backed up",
      );
      yield* fs.remove(installedSkill.path, { recursive: true });
      yield* refresh;
      assert.strictEqual((yield* load).installed_skills[0]?.status, "suppressed");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

/** The identity of the file `state.json` is: every save replaces it with a new one. */
const stateFile = (home: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(join(home, "state.json"))).pipe(
    Effect.map((info) => info.ino),
  );

it.effect("a batch that changes nothing on disk or in state saves nothing", () =>
  Effect.gen(function* () {
    const { fs, home, load, project } = yield* installedSkillFixture();
    yield* project();
    const before = yield* load;
    const bytes = yield* fs.readFileString(join(home, "state.json"));
    const file = yield* stateFile(home);
    yield* project();
    assert.deepStrictEqual(yield* stateFile(home), file);
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
    assert.deepStrictEqual(yield* load, before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unchanged batch still saves onto its loaded state before settling a backup", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, load, project } = yield* installedSkillFixture();
    yield* project();
    const installedSkill = (yield* load).installed_skills[0]!;
    // Killed after moving the intact copy aside and restoring it, before publishing anything.
    yield* fs.copy(yield* interruptedBackup(installedSkill), installedSkill.path);
    const file = yield* stateFile(home);
    yield* project();
    // The publication proves the state the backup is judged against is still the Library's.
    assert.notDeepEqual(yield* stateFile(home), file);
    assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a backup is never settled against a state the Library has moved on from", () =>
  Effect.gen(function* () {
    const { home, targetRoot, load, edit, project } = yield* installedSkillFixture();
    yield* project();
    const loaded = yield* load;
    const installedSkill = loaded.installed_skills[0]!;
    // A reproducible copy moved aside, then a writer without the lock changes the Library.
    yield* interruptedBackup(installedSkill);
    yield* edit(explicitPolicies);
    const failed = yield* uninstallCopies(home, loaded, [installedSkill]).pipe(Effect.flip);
    assert.strictEqual(failed._tag, "Library.StalePlan");
    assert.deepStrictEqual(
      (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
      ["pending"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps Library rows and records a stop when a replacement fails verification", () =>
  Effect.gen(function* () {
    const { fs, targetRoot, load, edit, project } = yield* installedSkillFixture();
    const target = join(targetRoot, "review");
    yield* project();
    yield* edit(explicitPolicies);
    const before = yield* load;
    const failed = yield* project().pipe(Effect.provide(divergingOn(target)), Effect.result);
    assert.strictEqual(Result.isFailure(failed), true);
    assert.strictEqual(yield* fs.exists(target), true);
    assert.deepStrictEqual(withoutOperations(yield* load), withoutOperations(before));
    assert.strictEqual((yield* load).operations.at(-1)?._tag, "Stopped");
    assert.deepStrictEqual(
      (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
      ["pending"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("records an earlier verified write when a later item's successor diverges", () =>
  Effect.gen(function* () {
    const { fs, targetRoot, load, edit, project } = yield* installedSkillFixture(true);
    yield* project();
    yield* edit(explicitPolicies);
    const before = yield* load;
    const second = join(targetRoot, "second");
    const failed = yield* project().pipe(Effect.provide(divergingOn(second)), Effect.result);
    assert.strictEqual(Result.isFailure(failed), true);
    assert.strictEqual(yield* fs.exists(second), true);
    const after = yield* load;
    const row = (state: LibraryState, path: string) =>
      state.installed_skills.find((installedSkill) => installedSkill.path === path);
    const review = join(targetRoot, "review");
    assert.strictEqual(row(after, review)?.status, "installed");
    assert.notStrictEqual(row(after, review)?.expected_hash, row(before, review)?.expected_hash);
    assert.deepStrictEqual(row(after, second), row(before, second));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const path of ["equivalent-version", "accepted-observation"] as const)
  it.effect(`never stamps a marker through a managed destination link (${path})`, () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, load, edit, project } = yield* installedSkillFixture();
      const target = join(targetRoot, "review");
      yield* project();
      const external = join(home, "authored");
      yield* fs.rename(target, external);
      yield* fs.symlink(external, target);
      const externalMarker = yield* fs.readFileString(join(external, ".skit-ownership.json"));
      const installed = (yield* load).installed_skills[0]!;
      if (path === "equivalent-version") {
        const newId = makeSkillVersionId();
        yield* edit((state) => ({
          ...state,
          skills: state.skills.map((skill) => ({
            ...skill,
            versions: skill.versions.map((version) => ({ ...version, skill_version_id: newId })),
          })),
          installed_skills: state.installed_skills.map((installedSkill) => ({
            ...installedSkill,
            skill_version_id: newId,
          })),
        }));
        yield* project();
      } else {
        const marker = yield* inspectOwnershipMarker(target);
        assert.strictEqual(marker.kind, "valid");
        if (marker.kind === "valid")
          yield* project({
            root: targetRoot,
            acceptedCopies: new Map([
              [
                installed.installed_skill_id,
                {
                  currentHash: yield* deterministicTreeHash(target),
                  marker: marker.marker,
                },
              ],
            ]),
          });
      }
      assert.strictEqual(
        yield* fs.readFileString(join(external, ".skit-ownership.json")),
        externalMarker,
      );
      assert.strictEqual((yield* fs.readLink(target).pipe(Effect.result))._tag, "Failure");
      assert.strictEqual((yield* inspectOwnershipMarker(target)).kind, "valid");
      assert.strictEqual((yield* load).installed_skills[0]?.status, "installed");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("backs up beside a symlinked root's real directory, on the copy's own device", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, edit, project } = yield* installedSkillFixture();
    const alias = join(home, "dotfiles-alias");
    yield* fs.symlink(targetRoot, alias);
    yield* project({ root: alias });
    yield* fs.makeDirectory(join(alias, "review", "notes", ".git"), { recursive: true });
    yield* fs.writeFileString(join(alias, "review", "notes", ".git", "HEAD"), "ref\n");
    yield* edit(explicitPolicies);
    yield* project({ root: alias });
    assert.deepStrictEqual(
      (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
      ["kept"],
    );
    assert.strictEqual(yield* fs.exists(join(home, ".skit-backups")), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const planted of [
  "ignore file link",
  "backups directory link",
  "permissive ignore file",
] as const)
  it.effect(`refuses to back up through a planted ${planted}`, () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, load, edit, project, retire } = yield* installedSkillFixture();
      yield* project();
      // A repository can commit its own `.skit-backups` beside the skills directory it shares.
      const outside = join(home, "outside");
      const sentinel = join(outside, "sentinel");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(sentinel, "unrelated bytes\n");
      const backups = join(dirname(targetRoot), ".skit-backups");
      if (planted === "backups directory link") yield* fs.symlink(outside, backups);
      else {
        yield* fs.makeDirectory(backups);
        if (planted === "ignore file link")
          yield* fs.symlink(sentinel, join(backups, ".gitignore"));
        // An ignore file that ignores nothing would let backups be committed.
        else yield* fs.writeFileString(join(backups, ".gitignore"), "");
      }
      yield* edit(unbound);

      const failed = yield* retire.pipe(Effect.result);

      assert.strictEqual(
        Result.isFailure(failed) && failed.failure._tag,
        "UnsafeInstalledSkillBackups",
      );
      assert.strictEqual(yield* fs.readFileString(sentinel), "unrelated bytes\n");
      assert.deepStrictEqual(yield* fs.readDirectory(outside), ["sentinel"]);
      assert.strictEqual(
        yield* fs.readFileString(join(targetRoot, "review", "SKILL.md")),
        "raw Skill bytes\n",
      );
      assert.strictEqual((yield* load).installed_skills[0]?.status, "installed");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

for (const location of ["beside", "inside"] as const)
  for (const settlement of ["keep", "discard"] as const)
    it.effect(
      `never settles a backup by ${settlement} through a planted link ${location} the root`,
      () =>
        Effect.gen(function* () {
          const { fs, home, targetRoot, load, project, refresh } = yield* installedSkillFixture();
          yield* project();
          const installedSkill = (yield* load).installed_skills[0]!;
          // Installed-skill ids are readable from ownership markers, so a planted entry can match one.
          const outside = join(home, "outside");
          const entry = join(outside, `pending-${installedSkill.installed_skill_id}-planted`);
          yield* fs.makeDirectory(outside);
          // Settling discards a copy SKIT could write again, and keeps anything else.
          if (settlement === "discard") yield* fs.copy(installedSkill.path, entry);
          else {
            yield* fs.makeDirectory(entry);
            yield* fs.writeFileString(join(entry, "SKILL.md"), "unrelated bytes\n");
          }
          const before = yield* losslessTree(outside);
          yield* fs.symlink(
            outside,
            join(location === "beside" ? dirname(targetRoot) : targetRoot, ".skit-backups"),
          );

          if (settlement === "keep") yield* refresh;
          yield* project();

          assert.ok(before);
          assert.strictEqual(yield* losslessTree(outside), before);
        }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );

it.effect(
  "works beside a root on its parent's device, and inside a root mounted from another",
  () =>
    Effect.gen(function* () {
      const devices = (root: bigint, parent: bigint) =>
        FileSystem.layerNoop({
          realPath: (path) => Effect.succeed(path),
          stat: (path) =>
            Effect.succeed({
              dev: path === "/home/me/.claude/skills" ? root : parent,
            } as FileSystem.File.Info),
        });
      assert.strictEqual(
        yield* installedSkillStagingDirectory("/home/me/.claude/skills").pipe(
          Effect.provide(devices(1n, 1n)),
        ),
        "/home/me/.claude",
      );
      assert.strictEqual(
        yield* installedSkillStagingDirectory("/home/me/.claude/skills").pipe(
          Effect.provide(devices(2n, 1n)),
        ),
        "/home/me/.claude/skills",
      );
    }),
);

for (const protection of [
  { marker: ".git", make: "directory" },
  { marker: "skit.json", make: "file" },
] as const)
  it.effect(
    `leaves a copy whose folder holds ${protection.marker}, and its record, as they are`,
    () =>
      Effect.gen(function* () {
        const { fs, targetRoot, load, edit, project } = yield* installedSkillFixture();
        const target = join(targetRoot, "review");
        yield* project();
        if (protection.make === "directory")
          yield* fs.makeDirectory(join(target, protection.marker));
        else yield* fs.writeFileString(join(target, protection.marker), "{}\n");
        const before = yield* deterministicTreeHash(target);
        const marker = yield* fs.readFileString(join(target, ".skit-ownership.json"));
        const recorded = (yield* load).installed_skills;
        // A new invocation policy would otherwise rewrite the copy.
        yield* edit(explicitPolicies);

        assert.strictEqual(yield* project(), 0);
        assert.strictEqual(yield* deterministicTreeHash(target), before);
        assert.strictEqual(yield* fs.readFileString(join(target, ".skit-ownership.json")), marker);
        assert.strictEqual(yield* fs.exists(join(target, protection.marker)), true);
        assert.deepStrictEqual((yield* load).installed_skills, recorded);
        assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("still updates a copy inside a repository whose root is above the skills folder", () =>
  Effect.gen(function* () {
    const { fs, targetRoot, load, edit, project } = yield* installedSkillFixture();
    const target = join(targetRoot, "review");
    // A dotfiles repository tracking the harness directory.
    yield* fs.makeDirectory(join(dirname(targetRoot), ".git"));
    yield* project();
    const before = yield* deterministicTreeHash(target);
    const [recorded] = (yield* load).installed_skills;
    yield* edit(explicitPolicies);

    assert.strictEqual(yield* project(), 1);
    assert.notStrictEqual(yield* deterministicTreeHash(target), before);
    const [updated] = (yield* load).installed_skills;
    assert.strictEqual(updated?.status, "installed");
    assert.strictEqual(updated?.installed_skill_id, recorded?.installed_skill_id);
    assert.notStrictEqual(updated?.expected_hash, recorded?.expected_hash);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("replaces an edited copy only as approved, keeping the edit in recovery", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, load, project } = yield* installedSkillFixture();
    const target = join(targetRoot, "review");
    yield* project();
    const written = yield* deterministicTreeHash(target);
    yield* fs.writeFileString(join(target, "SKILL.md"), "my edit\n");
    const editedHash = yield* deterministicTreeHash(target);
    const [recorded] = (yield* load).installed_skills;
    assert.ok(recorded);
    const plan = (approvals: Parameters<typeof planUpdate>[0]["approvals"]) =>
      planUpdate({ home, target: "agents", root: targetRoot, approvals });
    const change = (planned: Effect.Success<ReturnType<typeof plan>>) =>
      planned.plan.changes.find((item) => "path" in item && item.path === target);

    // Planned and applied in one write, as a reviewed change is.
    yield* inLibrary(home)(
      Effect.gen(function* () {
        // Unapproved, or approved for different bytes, the edit is a conflict that stays.
        const unapproved = yield* plan([]);
        assert.deepInclude(change(unapproved), {
          _tag: "Conflict",
          edited: true,
          skillVersionId: recorded.skill_version_id,
          recorded,
          currentHash: editedHash,
          hash: written,
          expectedHash: written,
        });
        const stale = yield* plan([
          {
            _tag: "ReplaceEdit",
            installedSkillId: recorded.installed_skill_id,
            currentHash: written,
          },
        ]);
        assert.strictEqual(change(stale)?._tag, "Conflict");

        const approved = yield* plan([
          {
            _tag: "ReplaceEdit",
            installedSkillId: recorded.installed_skill_id,
            currentHash: editedHash,
          },
        ]);
        assert.strictEqual(change(approved)?._tag, "Update");
        yield* approved.apply;
      }),
    );

    assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
    const [installed] = (yield* load).installed_skills;
    assert.strictEqual(installed?.status, "installed");
    assert.strictEqual(installed?.expected_hash, written);
    const backups = yield* backupsBeside(targetRoot);
    assert.deepStrictEqual(
      backups.map((backup) => backup.disposition),
      ["kept"],
    );
    assert.strictEqual(yield* fs.readFileString(join(backups[0]!.path, "SKILL.md")), "my edit\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
