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
import { prepareProjectionRetention } from "../src/workflows/library/projection-retention.js";
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
