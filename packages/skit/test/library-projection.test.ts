import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { TreeHasher, treeHasherLayer } from "../src/artifact/tree-hasher.js";
import { makeSkillVersionId, migratedMachineId } from "../src/library/entity-ids.js";
import { currentSkillVersion, versionBacking } from "../src/library/library-contracts.js";
import { retainedTreePath } from "../src/library/retention/retain-tree.js";
import { projectBindingEffect } from "../src/library/installation/project-binding.js";
import { retireUnboundGlobalProjectionsEffect } from "../src/library/installation/retire-unbound.js";
import { retainObservedCollectionEffect } from "../src/library/observed-import.js";
import { Digest } from "../src/library/store/state-schema.js";
import { LibraryStore, libraryStoreLayer } from "../src/library/store/library-store.js";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { inspectOwnershipMarkerEffect } from "../src/projection/mutation.js";

const machineId = migratedMachineId(
  "019950c0-4c00-7000-8000-000000000001",
  "library-projection-test",
);

/** A retained local Collection with one Skill globally bound to codex, not yet projected. */
const boundCollectionWith = (second = false) =>
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
    const secondSource = join(source, "second");
    if (second) {
      yield* fs.makeDirectory(secondSource);
      yield* fs.writeFileString(join(secondSource, "SKILL.md"), "second Skill bytes\n");
    }
    const retained = yield* Effect.scoped(
      withLibraryWriterLock(
        home,
        retainObservedCollectionEffect({
          machineId,
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: firstSource,
              relativePath: second ? "review" : ".",
              observedHash: yield* deterministicTreeHashEffect(firstSource),
            },
            ...(second
              ? [
                  {
                    name: "second",
                    sourcePath: secondSource,
                    relativePath: "second",
                    observedHash: yield* deterministicTreeHashEffect(secondSource),
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
        store.publish({
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
        }),
      ).pipe(Effect.provide(storeLayer)),
    );

    return { fs, home, targetRoot, storeLayer };
  });

const boundCollection = boundCollectionWith();

it.effect(
  "projects bound retained bytes, preserves a foreign target, and retires unbound custody",
  () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, storeLayer } = yield* boundCollection;

      const target = join(targetRoot, "review");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(join(target, "SKILL.md"), "foreign\n");
      const project = projectBindingEffect({
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
      const markerV2 = yield* inspectOwnershipMarkerEffect(target);
      assert.strictEqual(markerV2.kind, "valid");
      if (markerV2.kind === "valid") assert.strictEqual(markerV2.marker.schemaVersion, 4);

      yield* withLibraryWriterLock(
        home,
        Effect.flatMap(LibraryStore, (store) =>
          store.publish({
            ...installed,
            global_bindings: [],
          }),
        ).pipe(Effect.provide(storeLayer)),
      );
      const retire = retireUnboundGlobalProjectionsEffect({
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

it.effect("publishes nothing when the written Projection does not hash to the retained bytes", () =>
  Effect.gen(function* () {
    const { home, targetRoot, storeLayer } = yield* boundCollection;
    const diverged = Layer.succeed(TreeHasher)({
      hash: () => Effect.succeed(Schema.decodeUnknownSync(Digest)(`sha256:${"0".repeat(64)}`)),
    });
    const projected = yield* withLibraryWriterLock(
      home,
      projectBindingEffect({
        target: "agents",
        root: targetRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer), Effect.provide(diverged)),
    ).pipe(Effect.result);
    assert.strictEqual(Result.isFailure(projected), true);
    if (Result.isFailure(projected))
      assert.strictEqual(projected.failure._tag, "ProjectionFailure");
    const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    assert.deepStrictEqual(after.projections, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refreshes an equivalent Version handle only on an intact owned projection", () =>
  Effect.gen(function* () {
    const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
    const target = join(targetRoot, "review");
    const project = projectBindingEffect({
      target: "agents",
      root: targetRoot,
      variantsPath: join(home, "variants"),
    }).pipe(Effect.provide(storeLayer));
    yield* withLibraryWriterLock(home, project);
    const before = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    const hash = yield* deterministicTreeHashEffect(target);
    const newId = makeSkillVersionId();
    yield* withLibraryWriterLock(
      home,
      Effect.flatMap(LibraryStore, (store) =>
        store.publish({
          ...before,
          skills: before.skills.map((skill) => ({
            ...skill,
            versions: skill.versions.map((version) => ({ ...version, skill_version_id: newId })),
          })),
          projections: before.projections.map((projection) => ({
            ...projection,
            skill_version_id: newId,
          })),
        }),
      ).pipe(Effect.provide(storeLayer)),
    );
    yield* withLibraryWriterLock(home, project);
    const marker = yield* inspectOwnershipMarkerEffect(target);
    assert.strictEqual(marker.kind, "valid");
    if (marker.kind === "valid") {
      assert.strictEqual(marker.marker.skill_version_id, newId);
      assert.strictEqual(marker.marker.projection_id, before.projections[0]?.projection_id);
    }
    assert.strictEqual(yield* deterministicTreeHashEffect(target), hash);
    assert.strictEqual(yield* fs.readFileString(join(target, "SKILL.md")), "raw Skill bytes\n");
    // User edits still block metadata refresh and materialization.
    const editedId = makeSkillVersionId();
    const installed = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(storeLayer),
    );
    yield* withLibraryWriterLock(
      home,
      Effect.flatMap(LibraryStore, (store) =>
        store.publish({
          ...installed,
          skills: installed.skills.map((skill) => ({
            ...skill,
            versions: skill.versions.map((version) => ({ ...version, skill_version_id: editedId })),
          })),
          projections: installed.projections.map((projection) => ({
            ...projection,
            skill_version_id: editedId,
          })),
        }),
      ).pipe(Effect.provide(storeLayer)),
    );
    yield* fs.writeFileString(join(target, "SKILL.md"), "user edited bytes\n");
    yield* withLibraryWriterLock(home, project);
    const editedMarker = yield* inspectOwnershipMarkerEffect(target);
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
        projectBindingEffect({ target: "agents", root, variantsPath: join(home, "variants") }).pipe(
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
  it.effect(`refuses root relocation when the former projection's ${changed} changed`, () =>
    Effect.gen(function* () {
      const { fs, home, targetRoot, storeLayer } = yield* boundCollection;
      const newRoot = join(home, "new-harness", "skills");
      const project = (root: string) =>
        withLibraryWriterLock(
          home,
          projectBindingEffect({
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
        assert.strictEqual(result.failure._tag, "ProjectionRetireConflict");
        if (result.failure._tag === "ProjectionRetireConflict")
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
            store.publish({
              ...state,
              local_bindings: [{ scope: { kind: "repository", root: bindingRoot }, entries }],
            }),
          ).pipe(Effect.provide(storeLayer)),
        );
        const project = (
          target: "agents" | "claude",
          root: string,
          scope: { kind: "global" } | { kind: "repository"; root: string } = { kind: "global" },
        ) =>
          withLibraryWriterLock(
            home,
            projectBindingEffect({
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
          projectBindingEffect({
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
        projectBindingEffect({ target: "agents", root, variantsPath: join(home, "variants") }).pipe(
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
        projectBindingEffect({ target: "agents", root, variantsPath: join(home, "variants") }).pipe(
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
      assert.strictEqual(result.failure._tag, "Library.ProjectionInvalid");
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
    assert.deepStrictEqual(after, before);
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
        projectBindingEffect({ target, root, variantsPath: join(home, "variants") }).pipe(
          Effect.provide(storeLayer),
        ),
      );
    const retired = yield* withLibraryWriterLock(
      home,
      retireUnboundGlobalProjectionsEffect({
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
        projectBindingEffect({ target, root, variantsPath: join(home, "variants") }).pipe(
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
        store.publish({ ...state, global_bindings: [] }),
      ).pipe(Effect.provide(storeLayer)),
    );
    const retired = yield* withLibraryWriterLock(
      home,
      retireUnboundGlobalProjectionsEffect({
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
      projectBindingEffect({
        target: "claude",
        root: claudeRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer)),
    );
    const edited = join(claudeRoot, "review", "SKILL.md");
    yield* fs.writeFileString(edited, "my edit\n");
    const retire = withLibraryWriterLock(
      home,
      retireUnboundGlobalProjectionsEffect({
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
