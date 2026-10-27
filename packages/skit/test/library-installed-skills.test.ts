import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { TreeHasher, treeHasherLayer } from "../src/artifact/tree-hasher.js";
import { makeSkillVersionId, migratedMachineId } from "../src/library/entity-ids.js";
import { currentSkillVersion, versionBacking } from "../src/library/library-contracts.js";
import { retainedTreePath } from "../src/library/retention/retain-tree.js";
import { installEnabledSkills } from "../src/library/installation/install-enabled.js";
import { removeCollection } from "../src/library/installation/remove.js";
import { leftoverSkills, uninstallSkills } from "../src/library/installation/uninstall.js";
import { retainChangedInstalledSkill, importCollection } from "../src/library/import-collection.js";
import type { LibraryState } from "../src/library/library-state.js";
import { Digest } from "../src/vocabulary.js";
import {
  LibraryStore,
  lastSavedLibraryState,
  libraryStoreLayer,
  withLibraryWriter,
} from "../src/library/store/library-store.js";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { refreshLibraryInventory } from "../src/library/inventory/refresh.js";
import {
  backUpInstalledSkill,
  losslessTree,
  installedSkillWorkDirectory,
} from "../src/projection/backups.js";
import { inspectOwnershipMarker, withInstalledSkillMutation } from "../src/projection/mutation.js";

/** Uninstall the leftover global copies, as updating installed skills does. */
const uninstallLeftovers = (options: {
  variantsPath: string;
  activeTargets: Parameters<typeof leftoverSkills>[1]["activeDestinations"];
  desiredBindings?: Parameters<typeof leftoverSkills>[1]["enabled"];
  inactiveOnly?: boolean;
  onlySkillIds?: Parameters<typeof leftoverSkills>[1]["onlySkillIds"];
}) =>
  Effect.gen(function* () {
    const state = yield* (yield* LibraryStore).load;
    return yield* uninstallSkills(
      leftoverSkills(state, {
        activeDestinations: options.activeTargets,
        ...(options.desiredBindings === undefined ? {} : { enabled: options.desiredBindings }),
        ...(options.inactiveOnly === undefined ? {} : { inactiveOnly: options.inactiveOnly }),
        ...(options.onlySkillIds === undefined ? {} : { onlySkillIds: options.onlySkillIds }),
      }),
      { variantsPath: options.variantsPath, activeDestinations: options.activeTargets },
    );
  });

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
    const retained = yield* Effect.scoped(
      withLibraryWriterLock(
        home,
        importCollection({
          machineId,
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: firstSource,
              relativePath: second ? "review" : ".",
              observedHash: yield* deterministicTreeHash(firstSource),
            },
            ...(second
              ? [
                  {
                    name: "second",
                    sourcePath: secondSource,
                    relativePath: "second",
                    observedHash: yield* deterministicTreeHash(secondSource),
                  },
                ]
              : []),
          ],
          observations: [],
        }).pipe(Effect.provide(libraryStoreLayer({ home }))),
      ),
    );
    const storeLayer = libraryStoreLayer({ home });
    const initial = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    const skillId = retained.skills[0]?.skill_id;
    assert.ok(skillId);
    yield* withLibraryWriterLock(
      home,
      Effect.flatMap(LibraryStore, (store) =>
        store.save(
          {
            ...initial,
            global_bindings: [
              {
                scope: { kind: "global" },
                entries: retained.skills.map((skill) => ({
                  kind: "skill" as const,
                  skill_id: skill.skill_id,
                })),
              },
            ],
          },
          initial,
        ),
      ).pipe(Effect.provide(storeLayer)),
    );

    return { fs, home, targetRoot, storeLayer };
  });

const boundCollection = boundCollectionWith();

it.effect(
  "projects bound retained bytes, preserves a foreign target, and retires unbound ownership",
  () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, storeLayer } = yield* boundCollection;

      const target = join(targetRoot, "review");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(join(target, "SKILL.md"), "foreign\n");
      const project = installEnabledSkills({
        target: "agents",
        root: targetRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer));
      assert.strictEqual(
        Result.isSuccess(yield* withLibraryWriterLock(home, project).pipe(Effect.result)),
        true,
      );
      assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "foreign\n");
      const conflicted = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(conflicted.projections[0]?.status, "conflicted");

      yield* fs.remove(target, { recursive: true });
      yield* withLibraryWriterLock(home, project);
      assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
      assert.strictEqual(yield* fs.exists(join(target, ".skit-ownership.json")), true);
      const installed = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(installed.projections[0]?.status, "installed");
      const markerV2 = yield* inspectOwnershipMarker(target);
      assert.strictEqual(markerV2.kind, "valid");
      if (markerV2.kind === "valid") assert.strictEqual(markerV2.marker.schemaVersion, 4);

      yield* withLibraryWriterLock(
        home,
        Effect.flatMap(LibraryStore, (store) =>
          store.save(
            {
              ...installed,
              global_bindings: [],
            },
            installed,
          ),
        ).pipe(Effect.provide(storeLayer)),
      );
      const retire = uninstallLeftovers({
        variantsPath: join(home, "variants"),
        activeTargets: ["agents", "claude"],
      }).pipe(Effect.provide(storeLayer));
      assert.strictEqual(yield* withLibraryWriterLock(home, retire), 1);
      assert.strictEqual(yield* fs.exists(target), false);
      const retired = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.deepStrictEqual(retired.projections, []);
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "saves nothing when the written installed skill does not hash to the retained bytes",
  () =>
    Effect.gen(function* () {
      const { home, targetRoot, storeLayer } = yield* boundCollection;
      const diverged = Layer.succeed(TreeHasher)({
        hash: () => Effect.succeed(Schema.decodeUnknownSync(Digest)(`sha256:${"0".repeat(64)}`)),
      });
      const projected = yield* withLibraryWriterLock(
        home,
        installEnabledSkills({
          target: "agents",
          root: targetRoot,
          variantsPath: join(home, "variants"),
        }).pipe(Effect.provide(storeLayer), Effect.provide(diverged)),
      ).pipe(Effect.result);
      assert.strictEqual(Result.isFailure(projected), true);
      if (Result.isFailure(projected))
        assert.strictEqual(projected.failure._tag, "InstalledSkillFailure");
      const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.deepStrictEqual(after.projections, []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refreshes an equivalent Version handle only on an intact owned installed skill", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
    const target = join(targetRoot, "review");
    const project = installEnabledSkills({
      target: "agents",
      root: targetRoot,
      variantsPath: join(home, "variants"),
    }).pipe(Effect.provide(storeLayer));
    yield* withLibraryWriterLock(home, project);
    const before = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    const hash = yield* deterministicTreeHash(target);
    const newId = makeSkillVersionId();
    yield* withLibraryWriterLock(
      home,
      Effect.flatMap(LibraryStore, (store) =>
        store.save(
          {
            ...before,
            skills: before.skills.map((skill) => ({
              ...skill,
              versions: skill.versions.map((version) => ({ ...version, skill_version_id: newId })),
            })),
            projections: before.projections.map((projection) => ({
              ...projection,
              skill_version_id: newId,
            })),
          },
          before,
        ),
      ).pipe(Effect.provide(storeLayer)),
    );
    yield* withLibraryWriterLock(home, project);
    const marker = yield* inspectOwnershipMarker(target);
    assert.strictEqual(marker.kind, "valid");
    if (marker.kind === "valid") {
      assert.strictEqual(marker.marker.skill_version_id, newId);
      assert.strictEqual(marker.marker.projection_id, before.projections[0]?.projection_id);
    }
    assert.strictEqual(yield* deterministicTreeHash(target), hash);
    assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
    // User edits still block metadata refresh and materialization.
    const editedId = makeSkillVersionId();
    const installed = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    yield* withLibraryWriterLock(
      home,
      Effect.flatMap(LibraryStore, (store) =>
        store.save(
          {
            ...installed,
            skills: installed.skills.map((skill) => ({
              ...skill,
              versions: skill.versions.map((version) => ({
                ...version,
                skill_version_id: editedId,
              })),
            })),
            projections: installed.projections.map((projection) => ({
              ...projection,
              skill_version_id: editedId,
            })),
          },
          installed,
        ),
      ).pipe(Effect.provide(storeLayer)),
    );
    yield* fs.writeFileString(join(target, "SKILL.md"), "user edited bytes\n");
    yield* withLibraryWriterLock(home, project);
    const editedMarker = yield* inspectOwnershipMarker(target);
    assert.strictEqual(editedMarker.kind, "valid");
    if (editedMarker.kind === "valid")
      assert.strictEqual(editedMarker.marker.skill_version_id, newId);
    assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "user edited bytes\n");
    const conflicted = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    assert.strictEqual(conflicted.projections[0]?.status, "conflicted");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retires intact former roots when a globally bound Skill moves to a new root", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
    const newRoot = join(home, "new-harness", "skills");
    const project = (root: string) =>
      withLibraryWriterLock(
        home,
        installEnabledSkills({ target: "agents", root, variantsPath: join(home, "variants") }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    yield* project(targetRoot);
    yield* project(newRoot);
    assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), false);
    assert.strictEqual(
      yield* fs.readFileString(join(newRoot, "review", "SKILL.md")),
      "raw Skill bytes\n",
    );
    const load = LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
    const after = yield* load;
    assert.strictEqual(after.projections.length, 1);
    assert.strictEqual(after.projections[0]?.root, newRoot);
    assert.strictEqual(after.projections[0]?.status, "installed");
    yield* project(newRoot);
    assert.strictEqual((yield* load).projections.length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const changed of ["bytes", "ownership"] as const)
  it.effect(
    `refuses directory relocation when the former installed skill's ${changed} changed`,
    () =>
      Effect.gen(function* () {
        const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
        const newRoot = join(home, "new-harness", "skills");
        const project = (root: string) =>
          withLibraryWriterLock(
            home,
            installEnabledSkills({
              target: "agents",
              root,
              variantsPath: join(home, "variants"),
            }).pipe(Effect.provide(storeLayer)),
          );
        yield* project(targetRoot);
        const path = join(targetRoot, "review");
        if (changed === "bytes")
          yield* fs.writeFileString(join(path, "SKILL.md"), "my local edits\n");
        else yield* fs.remove(join(path, ".skit-ownership.json"));
        const load = LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
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
        const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
        const repository = join(home, "repository");
        const repositoryRoot = join(repository, ".agents", "skills");
        const bindingRoot = alias ? join(home, "repository-alias") : repository;
        if (alias) {
          yield* fs.makeDirectory(repository, { recursive: true });
          yield* fs.symlink(repository, bindingRoot);
        }
        const otherRoot = join(home, "claude", "skills");
        const newRoot = join(home, "new-harness", "skills");
        const load = LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
        const state = yield* load;
        const entries = state.global_bindings[0]?.entries;
        assert.ok(entries);
        yield* withLibraryWriterLock(
          home,
          LibraryStore.use((store) =>
            store.save(
              {
                ...state,
                local_bindings: [{ scope: { kind: "repository", root: bindingRoot }, entries }],
              },
              state,
            ),
          ).pipe(Effect.provide(storeLayer)),
        );
        const project = (
          target: "agents" | "claude",
          root: string,
          scope: { kind: "global" } | { kind: "repository"; root: string } = { kind: "global" },
        ) =>
          withLibraryWriterLock(
            home,
            installEnabledSkills({
              target,
              root,
              scope,
              variantsPath: join(home, "variants"),
            }).pipe(Effect.provide(storeLayer)),
          );
        yield* project("agents", targetRoot);
        yield* project("agents", repositoryRoot, { kind: "repository", root: bindingRoot });
        yield* project("claude", otherRoot);
        yield* project("agents", newRoot);
        assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), false);
        for (const root of [repositoryRoot, otherRoot, newRoot])
          assert.strictEqual(
            yield* fs.readFileString(join(root, "review", "SKILL.md")),
            "raw Skill bytes\n",
          );
        const after = yield* load;
        assert.deepStrictEqual(
          after.projections.map((projection) => projection.root).sort(),
          [repositoryRoot, otherRoot, newRoot].sort(),
        );
        assert.deepStrictEqual(after.local_bindings, [
          { scope: { kind: "repository", root: bindingRoot }, entries },
        ]);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "keeps the old working installation when the new root is occupied by a foreign copy",
  () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
      const newRoot = join(home, "new-harness", "skills");
      const newPath = join(newRoot, "review");
      const project = (root: string) =>
        withLibraryWriterLock(
          home,
          installEnabledSkills({
            target: "agents",
            root,
            variantsPath: join(home, "variants"),
          }).pipe(Effect.provide(storeLayer)),
        );
      yield* project(targetRoot);
      yield* fs.makeDirectory(newPath, { recursive: true });
      yield* fs.writeFileString(join(newPath, "SKILL.md"), "foreign Skill\n");
      yield* project(newRoot);
      assert.strictEqual(yield* fs.readFileString(join(newPath, "SKILL.md")), "foreign Skill\n");
      assert.strictEqual(
        yield* fs.readFileString(join(targetRoot, "review", "SKILL.md")),
        "raw Skill bytes\n",
      );
      const blocked = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(
        blocked.projections.find((projection) => projection.root === newRoot)?.status,
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
    const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
    const alias = join(home, "root-alias");
    const project = (root: string) =>
      withLibraryWriterLock(
        home,
        installEnabledSkills({ target: "agents", root, variantsPath: join(home, "variants") }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    yield* project(targetRoot);
    yield* fs.symlink(targetRoot, alias);
    yield* project(alias);
    assert.strictEqual(
      yield* fs.readFileString(join(targetRoot, "review", "SKILL.md")),
      "raw Skill bytes\n",
    );
    const after = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
    assert.strictEqual(after.projections.length, 1);
    assert.strictEqual(after.projections[0]?.root, alias);
    assert.strictEqual(after.projections[0]?.status, "installed");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps every former copy when a later Skill fails relocation", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer } = yield* boundCollectionWith(true);
    const project = (root: string) =>
      withLibraryWriterLock(
        home,
        installEnabledSkills({ target: "agents", root, variantsPath: join(home, "variants") }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    yield* project(targetRoot);
    const before = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    const second = before.skills.find((skill) => skill.name === "second");
    assert.ok(second);
    const version = currentSkillVersion(before, second);
    assert.ok(version);
    const backing = versionBacking(before, second, version);
    assert.ok(backing);
    yield* fs.writeFileString(
      join(
        retainedTreePath(join(home, "originals"), backing.copy.digest),
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
    const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    // The copy already written at the new root is recorded, so a retry keeps its ownership.
    assert.deepStrictEqual(after.projections.slice(0, 2), before.projections);
    assert.deepStrictEqual(
      after.projections.slice(2).map((projection) => [projection.path, projection.status]),
      [[join(newRoot, "review"), "installed"]],
    );
    assert.deepStrictEqual({ ...after, projections: [] }, { ...before, projections: [] });
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retires a bound Skill's copies at a target that is no longer active", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
    const claudeRoot = join(home, "claude", "skills");
    for (const [target, root] of [
      ["agents", targetRoot],
      ["claude", claudeRoot],
    ] as const)
      yield* withLibraryWriterLock(
        home,
        installEnabledSkills({ target, root, variantsPath: join(home, "variants") }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    const retired = yield* withLibraryWriterLock(
      home,
      uninstallLeftovers({
        variantsPath: join(home, "variants"),
        activeTargets: ["agents"],
      }).pipe(Effect.provide(storeLayer)),
    );
    assert.strictEqual(retired, 1);
    assert.strictEqual(yield* fs.exists(join(claudeRoot, "review")), false);
    assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), true);
    const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    assert.deepStrictEqual(
      after.projections.map((projection) => projection.target),
      ["agents"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a targeted reconcile retires only copies at inactive targets", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
    const claudeRoot = join(home, "claude", "skills");
    for (const [target, root] of [
      ["agents", targetRoot],
      ["claude", claudeRoot],
    ] as const)
      yield* withLibraryWriterLock(
        home,
        installEnabledSkills({ target, root, variantsPath: join(home, "variants") }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    // Unbinding everything must not retire the active copy when only inactive ones are in scope.
    yield* withLibraryWriterLock(
      home,
      Effect.flatMap(LibraryStore, (store) =>
        store.save({ ...state, global_bindings: [] }, state),
      ).pipe(Effect.provide(storeLayer)),
    );
    const retired = yield* withLibraryWriterLock(
      home,
      uninstallLeftovers({
        variantsPath: join(home, "variants"),
        activeTargets: ["agents"],
        inactiveOnly: true,
      }).pipe(Effect.provide(storeLayer)),
    );
    assert.strictEqual(retired, 1);
    assert.strictEqual(yield* fs.exists(join(claudeRoot, "review")), false);
    assert.strictEqual(yield* fs.exists(join(targetRoot, "review")), true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps and reports an edited copy at an inactive target without blocking", () =>
  Effect.gen(function* () {
    const { fs, home, storeLayer } = yield* boundCollection;
    const claudeRoot = join(home, "claude", "skills");
    yield* withLibraryWriterLock(
      home,
      installEnabledSkills({
        target: "claude",
        root: claudeRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer)),
    );
    const edited = join(claudeRoot, "review", "SKILL.md");
    yield* fs.writeFileString(edited, "my edit\n");
    const retire = withLibraryWriterLock(
      home,
      uninstallLeftovers({
        variantsPath: join(home, "variants"),
        activeTargets: ["agents"],
        inactiveOnly: true,
      }).pipe(Effect.provide(storeLayer)),
    );
    const load = Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );

    assert.strictEqual(yield* retire, 0);
    assert.strictEqual(yield* fs.readFileString(edited), "my edit\n");
    assert.deepStrictEqual(
      (yield* load).projections.map((projection) => [projection.target, projection.status]),
      [["claude", "conflicted"]],
    );

    // Once the operator removes the copy, the next pass releases the record.
    yield* fs.remove(join(claudeRoot, "review"), { recursive: true });
    yield* retire;
    assert.deepStrictEqual((yield* load).projections, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** A projectable Collection with the workflows and observations the backup tests drive. */
const projectionFixture = (second = false, emptyDirectories: readonly string[] = []) =>
  Effect.gen(function* () {
    const bound = yield* boundCollectionWith(second, emptyDirectories);
    const { home, targetRoot, storeLayer } = bound;
    const variantsPath = join(home, "variants");
    const load = LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
    const edit = (change: (state: LibraryState) => LibraryState) =>
      withLibraryWriterLock(
        home,
        LibraryStore.use((store) =>
          Effect.flatMap(store.load, (state) => store.save(change(state), state)),
        ).pipe(Effect.provide(storeLayer)),
      );
    const project = (
      options: Omit<Parameters<typeof installEnabledSkills>[0], "target" | "variantsPath"> = {
        root: targetRoot,
      },
    ) =>
      withLibraryWriterLock(
        home,
        installEnabledSkills({ target: "agents", variantsPath, ...options }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    const retire = withLibraryWriterLock(
      home,
      uninstallLeftovers({ variantsPath, activeTargets: ["agents"] }).pipe(
        Effect.asVoid,
        Effect.provide(storeLayer),
      ),
    );
    const remove = (state: LibraryState) =>
      withLibraryWriterLock(
        home,
        removeCollection(state, {
          collectionId: state.collections[0]!.collection_id,
          variantsPath,
        }).pipe(Effect.asVoid, Effect.provide(storeLayer)),
      );
    const refresh = withLibraryWriterLock(
      home,
      LibraryStore.use((store) =>
        Effect.flatMap(store.load, (loaded) =>
          refreshLibraryInventory(loaded, () => [{ harness: "codex", root: targetRoot }]),
        ),
      ).pipe(Effect.provide(storeLayer)),
    );
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
  global_bindings: state.global_bindings.map((binding) => ({
    ...binding,
    invocation_policies: Object.fromEntries(
      state.skills.map((skill) => [skill.skill_id, "explicit" as const]),
    ),
  })),
});

const unbound = (state: LibraryState): LibraryState => ({ ...state, global_bindings: [] });

/** A hasher that misreports the `nth` hash of one path, as a write diverging under SKIT would. */
const divergingOn = (path: string, nth: number) => {
  let calls = 0;
  return Layer.succeed(TreeHasher)({
    hash: (candidate) =>
      candidate === path && ++calls === nth
        ? Effect.succeed(Schema.decodeUnknownSync(Digest)(`sha256:${"0".repeat(64)}`))
        : deterministicTreeHash(candidate),
  });
};

it.effect(
  "manages equal content in place, keeping its excluded entries and empty directories",
  () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, project } = yield* projectionFixture();
      const target = join(targetRoot, "review");
      yield* fs.makeDirectory(join(target, ".git"), { recursive: true });
      yield* fs.makeDirectory(join(target, "notes"));
      yield* fs.writeFileString(join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
      yield* fs.writeFileString(join(target, "SKILL.md"), "raw Skill bytes\n");
      yield* project({
        root: targetRoot,
        manage: { path: target, observedHash: yield* deterministicTreeHash(target) },
      });
      assert.strictEqual(
        yield* fs.readFileString(join(target, ".git", "HEAD")),
        "ref: refs/heads/main\n",
      );
      assert.strictEqual((yield* fs.stat(join(target, "notes"))).type, "Directory");
      assert.strictEqual((yield* inspectOwnershipMarker(target)).kind, "valid");
      assert.strictEqual((yield* load).projections[0]?.status, "installed");
      assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "keeps the replaced copy in a pending backup when its install fails, then converges",
  () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, edit, project } = yield* projectionFixture();
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
      assert.strictEqual((yield* load).projections[0]?.status, "pending");

      yield* project();
      assert.notStrictEqual(yield* deterministicTreeHash(target), original);
      assert.strictEqual((yield* load).projections[0]?.status, "installed");
      // The retained original and the recorded declared policy restage the original exactly.
      assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

for (const content of ["reproducible", "git-bytes", "empty-directory"] as const)
  for (const action of ["replace", "retire"] as const)
    it.effect(`${action} keeps a backup only of a copy SKIT cannot restage (${content})`, () =>
      Effect.gen(function* () {
        const { fs, targetRoot, edit, project, retire } = yield* projectionFixture();
        const target = join(targetRoot, "review");
        yield* project();
        if (content === "git-bytes") {
          yield* fs.makeDirectory(join(target, ".git"));
          yield* fs.writeFileString(join(target, ".git", "config"), "[core]\n");
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
            yield* fs.readFileString(join(backups[0]!.path, ".git", "config")),
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
      }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
    );

for (const change of ["entry-name", "link-target", "root-mode"] as const)
  it.effect(`retire keeps a backup whose ${change} differs from what SKIT wrote`, () =>
    Effect.gen(function* () {
      const { fs, targetRoot, edit, project, retire } = yield* projectionFixture(false, ["a", "b"]);
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
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("retire discards a reproducible copy with empty directories", () =>
  Effect.gen(function* () {
    const { targetRoot, edit, project, retire } = yield* projectionFixture(false, ["a", "b"]);
    yield* project();
    yield* edit(unbound);
    yield* retire;
    assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

for (const original of ["intact", "missing", "corrupt"] as const)
  for (const action of ["replace", "retire", "remove"] as const)
    it.effect(
      `${action} discards a backup only with an intact retained original (${original})`,
      () =>
        Effect.gen(function* () {
          const { fs, home, targetRoot, storeLayer, load, edit, project, retire, remove } =
            yield* projectionFixture();
          const target = join(targetRoot, "review");
          yield* project();
          let backed = (yield* load).retained_copies[0]!.digest;
          let bytes = "raw Skill bytes\n";
          if (action === "replace") {
            // Install a second retained Version, then select the first again so the copy of the
            // second is the one replaced.
            const first = (yield* load).projections[0]!;
            bytes = "second Version bytes\n";
            yield* fs.writeFileString(join(target, "SKILL.md"), bytes);
            const second = yield* withLibraryWriterLock(
              home,
              retainChangedInstalledSkill({
                skillId: first.skill_id,
                projectionId: first.projection_id,
                path: target,
                observedHash: yield* deterministicTreeHash(target),
                retainedAt: "2026-09-17T00:00:00.000Z",
              }).pipe(Effect.provide(storeLayer)),
            );
            backed = second.snapshotDigest;
            yield* fs.remove(target, { recursive: true });
            yield* project();
            assert.strictEqual(
              (yield* load).projections[0]?.skill_version_id,
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
          const retained = retainedTreePath(join(home, "originals"), backed);
          if (original === "missing") yield* fs.remove(retained, { recursive: true });
          if (original === "corrupt")
            yield* fs.writeFileString(join(retained, "SKILL.md"), "tampered retained bytes\n");

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
        }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
    );

for (const batch of ["uninstall", "remove-collection"] as const)
  it.effect(
    `records the copies a failed ${batch} batch already retired, so none reads as a native deletion`,
    () =>
      Effect.gen(function* () {
        const { fs, load, edit, project, retire, remove, refresh } = yield* projectionFixture(true);
        yield* project();
        const state = yield* load;
        const [first, second] = state.projections;
        assert.ok(first && second);
        yield* fs.writeFileString(join(second.path, "SKILL.md"), "my edit\n");
        if (batch === "uninstall") yield* edit(unbound);
        const failed = yield* (batch === "uninstall" ? retire : remove(state)).pipe(Effect.result);
        assert.strictEqual(Result.isFailure(failed), true);
        // A failed removal keeps the Collection; only the copy it moved aside is recorded.
        assert.deepStrictEqual((yield* load).collections, state.collections);
        assert.strictEqual(yield* fs.exists(first.path), false);
        assert.strictEqual(yield* fs.readFileString(join(second.path, "SKILL.md")), "my edit\n");

        yield* refresh;
        assert.deepStrictEqual(
          (yield* load).projections.map((projection) => [
            projection.projection_id,
            projection.status,
          ]),
          [
            [first.projection_id, "pending"],
            [second.projection_id, "conflicted"],
          ],
        );
      }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "reads a copy moved to a pending backup as SKIT's absence, and a deletion as native",
  () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, project, refresh } = yield* projectionFixture();
      yield* project();
      const projection = (yield* load).projections[0];
      assert.ok(projection);
      // A process killed after moving the copy aside, before publishing what it meant to do.
      yield* backUpInstalledSkill(projection, "replace");
      yield* refresh;
      assert.strictEqual((yield* load).projections[0]?.status, "pending");
      yield* project();
      assert.strictEqual((yield* load).projections[0]?.status, "installed");
      assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);

      yield* fs.remove(projection.path, { recursive: true });
      yield* refresh;
      const deleted = (yield* load).projections[0];
      assert.strictEqual(deleted?.status, "suppressed");
      assert.strictEqual(deleted?.suppression_reason, "native_delete");
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

for (const stale of ["observed-successor", "settle-failure"] as const)
  it.effect(`a stale pending backup cannot hide a later native deletion (${stale})`, () =>
    Effect.gen(function* () {
      const { fs, targetRoot, load, edit, project, refresh } = yield* projectionFixture();
      yield* project();
      const projection = (yield* load).projections[0];
      assert.ok(projection);
      if (stale === "observed-successor") {
        // Killed after installing a successor but before publishing it; inventory then verifies it.
        const backup = yield* backUpInstalledSkill(projection, "replace");
        yield* fs.copy(backup, projection.path);
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
      yield* fs.remove(projection.path, { recursive: true });
      yield* refresh;
      assert.strictEqual((yield* load).projections[0]?.suppression_reason, "native_delete");
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
  );

/** The fixture's store, counting every publication a workflow attempts through it. */
const countingStore = (storeLayer: Layer.Layer<LibraryStore, never, FileSystem.FileSystem>) => {
  const counter = { saves: 0 };
  const layer = Layer.effect(
    LibraryStore,
    Effect.map(LibraryStore, (store) => ({
      ...store,
      save: (next: LibraryState, base: LibraryState) => {
        counter.saves++;
        return store.save(next, base);
      },
    })),
  ).pipe(Layer.provide(storeLayer));
  return { counter, layer };
};

it.effect("a batch that changes nothing on disk or in state saves nothing", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer, variantsPath, load, project } =
      yield* projectionFixture();
    yield* project();
    const before = yield* load;
    const bytes = yield* fs.readFileString(join(home, "state.json"));
    const { counter, layer } = countingStore(storeLayer);
    yield* withLibraryWriterLock(
      home,
      installEnabledSkills({ target: "agents", variantsPath, root: targetRoot }).pipe(
        Effect.provide(layer),
      ),
    );
    assert.strictEqual(counter.saves, 0);
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), bytes);
    assert.deepStrictEqual(yield* load, before);
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unchanged batch still saves onto its loaded state before settling a backup", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer, variantsPath, load, project } =
      yield* projectionFixture();
    yield* project();
    const projection = (yield* load).projections[0]!;
    // Killed after moving the intact copy aside and restoring it, before publishing anything.
    yield* fs.copy(yield* backUpInstalledSkill(projection, "replace"), projection.path);
    const { counter, layer } = countingStore(storeLayer);
    yield* withLibraryWriterLock(
      home,
      installEnabledSkills({ target: "agents", variantsPath, root: targetRoot }).pipe(
        Effect.provide(layer),
      ),
    );
    // The publication proves the state the backup is judged against is still the Library's.
    assert.strictEqual(counter.saves, 1);
    assert.deepStrictEqual(yield* backupsBeside(targetRoot), []);
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a backup is never settled against a state the Library has moved on from", () =>
  Effect.gen(function* () {
    const { home, targetRoot, storeLayer, variantsPath, load, edit, project } =
      yield* projectionFixture();
    yield* project();
    const loaded = yield* load;
    const projection = loaded.projections[0]!;
    // A reproducible copy moved aside, then a writer without the lock changes the Library.
    yield* backUpInstalledSkill(projection, "replace");
    yield* edit(explicitPolicies);
    const failed = yield* withLibraryWriterLock(
      home,
      LibraryStore.use((store) =>
        withInstalledSkillMutation(
          loaded,
          {
            rootFor: () => undefined,
            variantsPath,
            originalsPath: store.originalsPath,
            save: store.save,
          },
          (mutation) => mutation.uninstall(projection, "report", "unexpected conflict"),
        ),
      ).pipe(Effect.provide(storeLayer), Effect.flip),
    );
    assert.strictEqual(failed._tag, "LibraryChanged");
    assert.deepStrictEqual(
      (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
      ["pending"],
    );
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("the last published state stays the Library's across unchanged and changed batches", () =>
  Effect.gen(function* () {
    const { targetRoot, storeLayer, variantsPath, load, project } = yield* projectionFixture();
    yield* project();
    const initial = yield* load;
    const projectAgain = installEnabledSkills({ target: "agents", variantsPath, root: targetRoot });
    yield* withLibraryWriter(
      Effect.gen(function* () {
        const store = yield* LibraryStore;
        // What a caller applying several operations takes as the state the next one plans from.
        const expected = Effect.map(lastSavedLibraryState, (published) => published ?? initial);
        const current = Effect.gen(function* () {
          assert.deepStrictEqual(yield* expected, yield* store.load);
        });
        // Unchanged, then changed.
        yield* projectAgain;
        assert.strictEqual(yield* lastSavedLibraryState, undefined);
        yield* current;
        yield* store.save(explicitPolicies(yield* expected), yield* expected);
        yield* projectAgain;
        assert.notDeepEqual(yield* expected, initial);
        yield* current;
        // Changed, unchanged, then changed again.
        const changed = yield* expected;
        yield* projectAgain;
        assert.deepStrictEqual(yield* expected, changed);
        yield* current;
        yield* store.save(unbound(yield* expected), yield* expected);
        yield* uninstallLeftovers({
          variantsPath,
          activeTargets: ["agents"],
        });
        assert.deepStrictEqual((yield* expected).projections, []);
        yield* current;
      }),
    ).pipe(Effect.provide(storeLayer));
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("saves nothing for a replacement whose successor fails verification", () =>
  Effect.gen(function* () {
    const { fs, targetRoot, load, edit, project } = yield* projectionFixture();
    const target = join(targetRoot, "review");
    yield* project();
    yield* edit(explicitPolicies);
    const before = yield* load;
    const failed = yield* project().pipe(Effect.provide(divergingOn(target, 2)), Effect.result);
    assert.strictEqual(Result.isFailure(failed), true);
    assert.strictEqual(yield* fs.exists(target), true);
    assert.deepStrictEqual(yield* load, before);
    assert.deepStrictEqual(
      (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
      ["pending"],
    );
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("records an earlier verified write when a later item's successor diverges", () =>
  Effect.gen(function* () {
    const { fs, targetRoot, load, edit, project } = yield* projectionFixture(true);
    yield* project();
    yield* edit(explicitPolicies);
    const before = yield* load;
    const second = join(targetRoot, "second");
    const failed = yield* project().pipe(Effect.provide(divergingOn(second, 2)), Effect.result);
    assert.strictEqual(Result.isFailure(failed), true);
    assert.strictEqual(yield* fs.exists(second), true);
    const after = yield* load;
    const row = (state: LibraryState, path: string) =>
      state.projections.find((projection) => projection.path === path);
    const review = join(targetRoot, "review");
    assert.strictEqual(row(after, review)?.status, "installed");
    assert.notStrictEqual(
      row(after, review)?.expected_digest,
      row(before, review)?.expected_digest,
    );
    assert.deepStrictEqual(row(after, second), row(before, second));
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

for (const path of ["equivalent-version", "accepted-observation"] as const)
  it.effect(`never stamps a marker through a managed destination link (${path})`, () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, load, edit, project } = yield* projectionFixture();
      const target = join(targetRoot, "review");
      yield* project();
      const external = join(home, "authored");
      yield* fs.rename(target, external);
      yield* fs.symlink(external, target);
      const externalMarker = yield* fs.readFileString(join(external, ".skit-ownership.json"));
      const installed = (yield* load).projections[0]!;
      if (path === "equivalent-version") {
        const newId = makeSkillVersionId();
        yield* edit((state) => ({
          ...state,
          skills: state.skills.map((skill) => ({
            ...skill,
            versions: skill.versions.map((version) => ({ ...version, skill_version_id: newId })),
          })),
          projections: state.projections.map((projection) => ({
            ...projection,
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
            acceptedObservations: new Map([
              [
                installed.projection_id,
                {
                  observedHash: yield* deterministicTreeHash(target),
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
      assert.strictEqual((yield* load).projections[0]?.status, "installed");
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("backs up beside a symlinked root's real directory, on the copy's own device", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, edit, project } = yield* projectionFixture();
    const alias = join(home, "dotfiles-alias");
    yield* fs.symlink(targetRoot, alias);
    yield* project({ root: alias });
    yield* fs.makeDirectory(join(alias, "review", ".git"));
    yield* fs.writeFileString(join(alias, "review", ".git", "HEAD"), "ref\n");
    yield* edit(explicitPolicies);
    yield* project({ root: alias });
    assert.deepStrictEqual(
      (yield* backupsBeside(targetRoot)).map((backup) => backup.disposition),
      ["kept"],
    );
    assert.strictEqual(yield* fs.exists(join(home, ".skit-backups")), false);
  }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
);

for (const planted of [
  "ignore file link",
  "backups directory link",
  "permissive ignore file",
] as const)
  it.effect(`refuses to back up through a planted ${planted}`, () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, load, edit, project, retire } = yield* projectionFixture();
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
      assert.strictEqual((yield* load).projections[0]?.status, "installed");
    }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
  );

for (const location of ["beside", "inside"] as const)
  for (const settlement of ["keep", "discard"] as const)
    it.effect(
      `never settles a backup by ${settlement} through a planted link ${location} the root`,
      () =>
        Effect.gen(function* () {
          const { fs, home, targetRoot, load, project, refresh } = yield* projectionFixture();
          yield* project();
          const projection = (yield* load).projections[0]!;
          // Installed-skill ids are readable from ownership markers, so a planted entry can match one.
          const outside = join(home, "outside");
          const entry = join(outside, `pending-${projection.projection_id}-planted`);
          yield* fs.makeDirectory(outside);
          // Settling discards a copy SKIT could write again, and keeps anything else.
          if (settlement === "discard") yield* fs.copy(projection.path, entry);
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
        }).pipe(Effect.provide(treeHasherLayer), Effect.provide(skitLayer), Effect.scoped),
    );

it("works beside a root on its parent's device, and inside a root mounted from another", () => {
  assert.strictEqual(
    installedSkillWorkDirectory("/home/me/.claude/skills", 1, 1),
    "/home/me/.claude",
  );
  assert.strictEqual(
    installedSkillWorkDirectory("/home/me/.claude/skills", 2, 1),
    "/home/me/.claude/skills",
  );
});
