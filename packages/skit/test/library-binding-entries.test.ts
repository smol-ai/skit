import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { projectBindingEffect } from "../src/library/installation/project-binding.js";
import type { BindingEntry } from "../src/library/library-contracts.js";
import { retainObservedCollectionEffect } from "../src/library/observed-import.js";
import { LibraryStore, libraryStoreLayer } from "../src/library/store/library-store.js";
import { withLibraryWriterLock } from "../src/library/store/writer-lock.js";
import { skitLayer } from "../src/platform/layer.js";

const machineId = migratedMachineId(
  "019950c0-4c00-7000-8000-000000000001",
  "library-binding-entries-test",
);

/** A GitHub Source whose Skills the test adds and deletes between refreshes. */
const upstream = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-binding-entries-" });
  const home = join(workspace, "home");
  const checkout = join(workspace, "checkout");
  const root = join(workspace, "codex");
  const storeLayer = libraryStoreLayer({ home });
  yield* fs.makeDirectory(root, { recursive: true });
  let refreshes = 0;
  const refresh = (names: readonly string[]) =>
    Effect.gen(function* () {
      refreshes++;
      const skills = [];
      for (const name of names) {
        const directory = join(checkout, name);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(join(directory, "SKILL.md"), `${name}\n`);
        skills.push({
          name,
          sourcePath: directory,
          relativePath: name,
          observedHash: yield* deterministicTreeHashEffect(directory),
        });
      }
      return yield* Effect.scoped(
        withLibraryWriterLock(
          home,
          retainObservedCollectionEffect({
            machineId,
            source: { type: "github", owner: "fixture", repository: "skills" },
            input: "https://github.com/fixture/skills",
            revision: { kind: "commit", commit: String(refreshes).repeat(40) },
            retainedAt: `2026-09-16T0${refreshes}:00:00.000Z`,
            skills,
            observations: [],
          }).pipe(Effect.provide(storeLayer)),
        ),
      );
    });
  const load = Effect.flatMap(LibraryStore, (store) => store.load).pipe(Effect.provide(storeLayer));
  const enable = (entries: readonly BindingEntry[]) =>
    Effect.gen(function* () {
      const state = yield* load;
      yield* withLibraryWriterLock(
        home,
        Effect.flatMap(LibraryStore, (store) =>
          store.publish({
            ...state,
            global_bindings: [{ scope: { kind: "global" }, entries }],
          }),
        ).pipe(Effect.provide(storeLayer)),
      );
    });
  const project = withLibraryWriterLock(
    home,
    projectBindingEffect({
      target: "agents",
      root,
      variantsPath: join(home, "variants"),
    }).pipe(Effect.provide(storeLayer)),
  );
  const installed = Effect.gen(function* () {
    return (yield* fs.readDirectory(root)).sort();
  });
  return { refresh, load, enable, project, installed };
});

it.effect("a whole-Collection entry installs Skills added upstream and retires deleted ones", () =>
  Effect.gen(function* () {
    const { refresh, enable, project, installed } = yield* upstream;
    const first = yield* refresh(["alpha", "beta"]);
    assert.ok(first.collection);
    yield* enable([{ kind: "collection", collection_id: first.collection.collection_id }]);
    yield* project;
    assert.deepStrictEqual(yield* installed, ["alpha", "beta"]);

    yield* refresh(["alpha", "gamma"]);
    yield* project;
    assert.deepStrictEqual(yield* installed, ["alpha", "gamma"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an individually enabled Skill deleted upstream stays installed", () =>
  Effect.gen(function* () {
    const { refresh, load, enable, project, installed } = yield* upstream;
    const first = yield* refresh(["alpha", "beta"]);
    const beta = first.skills.find((skill) => skill.name === "beta");
    assert.ok(beta);
    yield* enable([{ kind: "skill", skill_id: beta.skill_id }]);
    yield* project;
    assert.deepStrictEqual(yield* installed, ["beta"]);

    yield* refresh(["alpha"]);
    const state = yield* load;
    assert.ok(state.skills.some((skill) => skill.skill_id === beta.skill_id));
    yield* project;
    assert.deepStrictEqual(yield* installed, ["beta"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
