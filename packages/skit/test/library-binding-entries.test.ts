import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { installEnabledSkills } from "../src/library/installation/install-enabled.js";
import { removeCollection } from "../src/library/installation/remove.js";
import type { Enabled } from "../src/library/library-contracts.js";
import { importCollection } from "../src/library/import-collection.js";
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
          currentHash: yield* deterministicTreeHash(directory),
        });
      }
      return yield* Effect.scoped(
        withLibraryWriterLock(
          home,
          importCollection({
            machineId,
            source: { type: "github", owner: "fixture", repository: "skills" },
            input: "https://github.com/fixture/skills",
            revision: { kind: "commit", commit: String(refreshes).repeat(40) },
            importedAt: `2026-09-16T0${refreshes}:00:00.000Z`,
            skills,
            observations: [],
          }).pipe(Effect.provide(storeLayer)),
        ),
      );
    });
  const load = Effect.flatMap(LibraryStore, (store) => store.load).pipe(Effect.provide(storeLayer));
  const enable = (enabled: readonly Enabled[]) =>
    Effect.gen(function* () {
      const state = yield* load;
      yield* withLibraryWriterLock(
        home,
        Effect.flatMap(LibraryStore, (store) =>
          store.save(
            {
              ...state,
              enabled: [...enabled],
            },
            state,
          ),
        ).pipe(Effect.provide(storeLayer)),
      );
    });
  const project = withLibraryWriterLock(
    home,
    installEnabledSkills({
      target: "agents",
      root,
      variantsPath: join(home, "variants"),
    }).pipe(Effect.provide(storeLayer)),
  );
  const installed = Effect.gen(function* () {
    return (yield* fs.readDirectory(root)).sort();
  });
  return { refresh, load, enable, project, installed, home, storeLayer };
});

it.effect("a whole-Collection entry installs Skills added upstream and retires deleted ones", () =>
  Effect.gen(function* () {
    const { refresh, enable, project, installed } = yield* upstream;
    const first = yield* refresh(["alpha", "beta"]);
    assert.ok(first.collection);
    yield* enable([{ collection: first.collection.collection_id }]);
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
    yield* enable([{ skill: beta.skill_id }]);
    yield* project;
    assert.deepStrictEqual(yield* installed, ["beta"]);

    yield* refresh(["alpha"]);
    const state = yield* load;
    assert.ok(state.skills.some((skill) => skill.skill_id === beta.skill_id));
    yield* project;
    assert.deepStrictEqual(yield* installed, ["beta"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses to remove a Collection that gained a member after removal was planned", () =>
  Effect.gen(function* () {
    const { refresh, load, enable, project, installed, home, storeLayer } = yield* upstream;
    const first = yield* refresh(["alpha"]);
    assert.ok(first.collection);
    const collectionId = first.collection.collection_id;
    yield* enable([{ collection: collectionId }]);
    yield* project;
    const planned = yield* load;

    yield* refresh(["alpha", "beta"]);
    yield* project;
    const error = yield* withLibraryWriterLock(
      home,
      removeCollection(planned, { collectionId, variantsPath: join(home, "variants") }),
    ).pipe(Effect.provide(storeLayer), Effect.flip);

    assert.strictEqual(error._tag, "LibraryChanged");
    const state = yield* load;
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
    assert.strictEqual(state.installed_skills.length, 2);
    assert.deepStrictEqual(yield* installed, ["alpha", "beta"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
