import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryStore,
  libraryStoreLayer,
  projectBindingEffect,
  skitLayer,
} from "@smolai/skit-core";
import {
  prepareProjectionRetention,
  projectionComparisonPaths,
  useSkillVersion,
} from "../src/workflows/library/projection-retention.js";
import { initializeLibraryMachine, retainObservedIn, writingTo } from "./helpers/library-home.js";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { isolatedRoots } from "./helpers/isolated-library.js";

const projectionFixture = Effect.gen(function* () {
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
      retainObservedIn(home)({
        source: { type: "local", path: source },
        input: source,
        retainedAt: now(),
        skills: [
          {
            name: "review",
            sourcePath: source,
            relativePath: ".",
            observedHash: yield* deterministicTreeHashEffect(source),
          },
        ],
        observations: [],
      }),
    ),
  );
  const storeLayer = libraryStoreLayer({ home });
  const initial = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
  const skill = initial.skills.find(
    (candidate) => candidate.collection_id === collection.collection?.collection_id,
  );
  assert.ok(skill);
  yield* writingTo(
    home,
    LibraryStore.use((store) =>
      store.publish(
        {
          ...initial,
          global_bindings: [
            {
              scope: { kind: "global" as const },
              entries: [{ kind: "skill" as const, skill_id: skill.skill_id }],
            },
          ],
        },
        initial,
      ),
    ).pipe(Effect.provide(storeLayer)),
  );
  const rootByTarget = { agents: roots.codexRoot, claude: roots.claudeRoot } as const;
  for (const target of ["agents", "claude"] as const)
    yield* writingTo(
      home,
      projectBindingEffect({
        target,
        root: rootByTarget[target],
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer)),
    );
  yield* fs.writeFileString(join(roots.codexRoot, "review", "SKILL.md"), "selected change\n");
  yield* fs.writeFileString(join(roots.claudeRoot, "review", "SKILL.md"), "different change\n");

  return { fs, workspace, roots, home, source, now, skill, storeLayer };
});

it.effect.each(["account", "device"] as const)(
  "using the Library with %s selection saves the edit as a Version and can switch back to it",
  (selection) =>
    Effect.gen(function* () {
      const { fs, roots, home, skill, storeLayer } = yield* projectionFixture;
      if (selection === "device")
        yield* writingTo(
          home,
          LibraryStore.use((store) =>
            Effect.gen(function* () {
              const state = yield* store.load;
              yield* store.publish(
                {
                  ...state,
                  global_bindings: [],
                  device_skill_selection: {
                    mode: "choose",
                    binding: {
                      scope: { kind: "global" },
                      entries: [{ kind: "skill", skill_id: skill.skill_id }],
                    },
                  },
                },
                state,
              );
            }),
          ).pipe(Effect.provide(storeLayer)),
        );
      const agents = join(roots.codexRoot, "review");
      const claude = join(roots.claudeRoot, "review");
      yield* fs.writeFileString(join(agents, "notes.txt"), "local supporting file\n");
      const prepared = yield* prepareProjectionRetention(skill.name, "agents").pipe(
        Effect.provide(storeLayer),
      );
      const result = yield* prepared.useLibrary().pipe(Effect.provide(storeLayer));
      assert.ok(result.saved_skill_version_id);
      assert.strictEqual(result.skill_version_id, prepared.preview.previous_skill_version_id);
      assert.strictEqual(yield* fs.readFileString(join(agents, "SKILL.md")), "original\n");
      assert.strictEqual(yield* fs.exists(join(agents, "notes.txt")), false);
      assert.strictEqual(yield* fs.readFileString(join(claude, "SKILL.md")), "different change\n");
      const reverted = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(reverted.skills[0]?.local_version_id, undefined);

      yield* useSkillVersion(skill.name, result.saved_skill_version_id, false).pipe(
        Effect.provide(storeLayer),
      );
      assert.strictEqual(yield* fs.readFileString(join(agents, "SKILL.md")), "selected change\n");
      assert.strictEqual(
        yield* fs.readFileString(join(agents, "notes.txt")),
        "local supporting file\n",
      );
      assert.strictEqual(yield* fs.readFileString(join(claude, "SKILL.md")), "different change\n");
      const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
      assert.strictEqual(state.projections.length, 2);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("using the Library refuses when the previewed files change", () =>
  Effect.gen(function* () {
    const { fs, roots, skill, storeLayer } = yield* projectionFixture;
    const path = join(roots.codexRoot, "review", "SKILL.md");
    const prepared = yield* prepareProjectionRetention(skill.name, "agents").pipe(
      Effect.provide(storeLayer),
    );
    yield* fs.writeFileString(path, "changed since preview\n");
    const failure = yield* prepared.useLibrary().pipe(Effect.provide(storeLayer), Effect.flip);
    assert.strictEqual(failure._tag, "Library.ProjectionRetentionStale");
    assert.strictEqual(yield* fs.readFileString(path), "changed since preview\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("repair leaves a different Skill in the same agent directory alone", () =>
  Effect.gen(function* () {
    const { fs, workspace, roots, home, skill, storeLayer } = yield* projectionFixture;
    const source = join(workspace, "sibling-source");
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(join(source, "SKILL.md"), "sibling\n");
    const added = yield* Effect.scoped(
      writingTo(
        home,
        retainObservedIn(home)({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-09-17T00:00:00.000Z",
          skills: [
            {
              name: "sibling",
              sourcePath: source,
              relativePath: ".",
              observedHash: yield* deterministicTreeHashEffect(source),
            },
          ],
          observations: [],
        }),
      ),
    );
    const before = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
    const sibling = before.skills.find(
      (item) => item.collection_id === added.collection?.collection_id,
    )!;
    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        store.publish(
          {
            ...before,
            global_bindings: [
              {
                scope: { kind: "global" },
                entries: [
                  { kind: "skill", skill_id: skill.skill_id },
                  { kind: "skill", skill_id: sibling.skill_id },
                ],
              },
            ],
          },
          before,
        ),
      ).pipe(Effect.provide(storeLayer)),
    );
    yield* writingTo(
      home,
      projectBindingEffect({
        target: "agents",
        root: roots.codexRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(storeLayer)),
    );
    const siblingPath = join(roots.codexRoot, "sibling", "SKILL.md");
    const siblingBefore = yield* fs.readFileString(siblingPath);
    const prepared = yield* prepareProjectionRetention(skill.name, "agents").pipe(
      Effect.provide(storeLayer),
    );
    const result = yield* prepared.useLibrary().pipe(Effect.provide(storeLayer));
    assert.ok(result.saved_skill_version_id);
    assert.strictEqual(yield* fs.readFileString(siblingPath), siblingBefore);
    const after = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
    assert.ok(
      after.projections.some(
        (item) => item.skill_id === sibling.skill_id && item.target === "agents",
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "retains explicitly selected Projection bytes and accepts only identical observations",
  () =>
    Effect.gen(function* () {
      const { fs, roots, home, source, skill, storeLayer } = yield* projectionFixture;
      const before = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      const prepared = yield* prepareProjectionRetention(skill.name, "agents").pipe(
        Effect.provide(storeLayer),
      );
      const plan = prepared.preview;
      assert.strictEqual(plan.skill_id, skill.skill_id);
      assert.deepStrictEqual(
        plan.projections.map((projection) => [projection.target, projection.agreement]),
        [
          ["agents", "selected"],
          ["claude", "different"],
        ],
      );
      assert.strictEqual(before.skills[0]?.versions.length, 1);
      assert.strictEqual(yield* fs.exists(plan.retained_path), false);
      const comparison = yield* projectionComparisonPaths(plan).pipe(Effect.provide(storeLayer));
      assert.strictEqual(
        yield* fs.readFileString(join(comparison.libraryPath, "SKILL.md")),
        "original\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(join(comparison.installedPath, "SKILL.md")),
        "selected change\n",
      );

      const result = yield* prepared.apply().pipe(Effect.provide(storeLayer));
      assert.deepStrictEqual(
        result.projections.map((projection) => [projection.target, projection.status]),
        [
          ["agents", "projected"],
          ["claude", "conflicted"],
        ],
      );
      const after = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(storeLayer));
      const retained = after.skills.find((candidate) => candidate.skill_id === skill.skill_id)!;
      assert.strictEqual(retained.versions.length, 2);
      assert.strictEqual(retained.local_version_id, result.retained_skill_version_id);
      assert.strictEqual(after.acquisitions.at(-1)?.source_identity.kind, "local");
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
          retainObservedIn(home)({
            source: { type: "local", path: source },
            input: source,
            retainedAt: "2026-09-18T00:00:00.000Z",
            skills: [
              {
                name: "review",
                sourcePath: source,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(source),
              },
            ],
            observations: [],
          }),
        ),
      );
      const refreshed = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(storeLayer),
      );
      assert.deepStrictEqual(refreshed.acquisitions, after.acquisitions);
      assert.strictEqual(
        refreshed.skills.find((candidate) => candidate.skill_id === skill.skill_id)
          ?.local_version_id,
        result.retained_skill_version_id,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["selected", "other", "Library", "home"] as const)(
  "refuses a prepared retention after %s changes without retaining or projecting",
  (change) =>
    Effect.gen(function* () {
      const f = yield* projectionFixture;
      const prepared = yield* prepareProjectionRetention(f.skill.name, "agents").pipe(
        Effect.provide(f.storeLayer),
      );
      let applicationLayer = f.storeLayer;
      const otherHome = join(f.workspace, "other-library");
      if (change === "home") applicationLayer = libraryStoreLayer({ home: otherHome });
      else if (change === "Library") {
        yield* writingTo(
          f.home,
          LibraryStore.use((store) =>
            Effect.gen(function* () {
              const state = yield* store.load;
              yield* store.publish(
                {
                  ...state,
                  collections: state.collections.map((collection) => ({
                    ...collection,
                    label: "renamed",
                  })),
                },
                state,
              );
            }),
          ).pipe(Effect.provide(f.storeLayer)),
        );
      } else {
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
      assert.strictEqual(failure._tag, "Library.ProjectionRetentionStale");
      yield* assertDiskUnchanged(before);
      const state = yield* LibraryStore.use((store) => store.load).pipe(
        Effect.provide(f.storeLayer),
      );
      assert.strictEqual(state.skills[0]?.versions.length, 1);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("adopts identical edited copies into one retained Version", () =>
  Effect.gen(function* () {
    const f = yield* projectionFixture;
    yield* f.fs.writeFileString(
      join(f.roots.claudeRoot, "review", "SKILL.md"),
      "selected change\n",
    );
    const before = yield* captureDisk([f.home, f.roots.codexRoot, f.roots.claudeRoot], {
      identity: true,
    });
    const prepared = yield* prepareProjectionRetention(f.skill.name, "agents").pipe(
      Effect.provide(f.storeLayer),
    );
    yield* assertDiskUnchanged(before);
    assert.deepStrictEqual(
      prepared.preview.projections.map((item) => item.agreement),
      ["selected", "identical"],
    );
    const result = yield* prepared.apply().pipe(Effect.provide(f.storeLayer));
    assert.deepStrictEqual(
      result.projections.map((item) => item.status),
      ["projected", "projected"],
    );
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(f.storeLayer));
    assert.strictEqual(state.skills[0]?.versions.length, 2);
    assert.strictEqual(new Set(state.projections.map((item) => item.skill_version_id)).size, 1);
    for (const root of [f.roots.codexRoot, f.roots.claudeRoot])
      assert.strictEqual(
        yield* f.fs.readFileString(join(root, "review", "SKILL.md")),
        "selected change\n",
      );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
