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
import { isolatedRoots } from "./helpers/isolated-library.js";
import { initializeLibraryMachine, retainObservedIn, writingTo } from "./helpers/library-home.js";

const boundRawReview = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-advance-" });
  const roots = isolatedRoots(workspace);
  const home = roots.home;
  const source = join(workspace, "raw-review");
  const layer = libraryStoreLayer({ home });
  yield* initializeLibraryMachine(home);
  yield* fs.makeDirectory(source, { recursive: true });
  const observe = (text: string) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(join(source, "SKILL.md"), text);
      return yield* Effect.scoped(
        writingTo(
          home,
          retainObservedIn(home)({
            source: { type: "local", locator: source },
            input: source,
            retainedAt: "2026-09-16T00:00:00.000Z",
            skills: [
              {
                name: "raw-review",
                sourcePath: source,
                relativePath: "raw-review",
                observedHash: yield* deterministicTreeHashEffect(source),
              },
            ],
            observations: [],
          }),
        ),
      );
    });
  const first = yield* observe("first verbatim Skill\n");
  const bound = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
  assert.ok(bound);
  yield* writingTo(
    home,
    LibraryStore.use((store) =>
      store.publish({
        ...bound,
        global_bindings: [
          {
            harness: "codex",
            scope: { kind: "global" },
            skills: bound.skills
              .filter((skill) => skill.collection_id === first.collection?.collection_id)
              .map((skill) => skill.skill_id),
          },
        ],
      }),
    ).pipe(Effect.provide(layer)),
  );
  const project = writingTo(
    home,
    projectBindingEffect({
      harness: "codex",
      root: roots.codexRoot,
      variantsPath: join(home, "variants"),
    }).pipe(Effect.provide(layer)),
  );
  yield* project;
  const projected = join(roots.codexRoot, "raw-review", "SKILL.md");
  assert.strictEqual(yield* fs.readFileString(projected), "first verbatim Skill\n");
  const projection = Effect.gen(function* () {
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(state);
    const row = state.projections.find((item) => item.harness === "codex");
    assert.ok(row);
    return { row, selected: state.skills[0]?.selected_skill_version_id };
  });
  return { fs, home, layer, observe, project, projected, projection };
});

it.effect("rewrites an untouched Projection when the selected Version advances", () =>
  Effect.gen(function* () {
    const { fs, observe, project, projected, projection } = yield* boundRawReview;
    yield* observe("second verbatim Skill\n");
    yield* project;
    assert.strictEqual(yield* fs.readFileString(projected), "second verbatim Skill\n");
    const { row, selected } = yield* projection;
    assert.strictEqual(row.status, "installed");
    assert.strictEqual(row.skill_version_id, selected);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps a locally edited Projection conflicted when the selected Version advances", () =>
  Effect.gen(function* () {
    const { fs, home, observe, project, projected, projection } = yield* boundRawReview;
    yield* fs.writeFileString(projected, "my local edit\n");
    yield* observe("second verbatim Skill\n");
    yield* project;
    assert.strictEqual(yield* fs.readFileString(projected), "my local edit\n");
    const { row } = yield* projection;
    assert.strictEqual(row.status, "conflicted");
    const variants = join(home, "variants", "codex", "raw-review");
    const [variant, ...others] = yield* fs.readDirectory(variants);
    assert.ok(variant);
    assert.deepStrictEqual(others, []);
    assert.strictEqual(
      yield* fs.readFileString(join(variants, variant, "SKILL.md")),
      "my local edit\n",
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Before the fix, an update left untouched Projections recorded as conflicted at the new Version.
it.effect("heals an untouched Projection already recorded as conflicted", () =>
  Effect.gen(function* () {
    const { fs, home, layer, observe, project, projected, projection } = yield* boundRawReview;
    yield* observe("second verbatim Skill\n");
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(state);
    const selected = state.skills[0]?.selected_skill_version_id;
    assert.ok(selected);
    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        store.publish({
          ...state,
          projections: state.projections.map((row) => ({
            ...row,
            skill_version_id: selected,
            status: "conflicted" as const,
          })),
        }),
      ).pipe(Effect.provide(layer)),
    );
    yield* project;
    assert.strictEqual(yield* fs.readFileString(projected), "second verbatim Skill\n");
    const { row } = yield* projection;
    assert.strictEqual(row.status, "installed");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
