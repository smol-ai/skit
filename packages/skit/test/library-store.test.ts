import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { retainObservedCollectionEffect } from "../src/library/observed-import.js";
import { LibraryStore, libraryStoreLayer } from "../src/library/store/library-store.js";
import { skitLayer } from "../src/platform/layer.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "library-store-test");

const library = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-store-" });
  const home = join(workspace, "home");
  const source = join(workspace, "source");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "raw Skill bytes\n");
  const inLibrary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(libraryStoreLayer({ home })));
  yield* inLibrary(
    Effect.scoped(
      retainObservedCollectionEffect({
        machineId,
        source: { type: "local", path: source },
        input: source,
        retainedAt: "2026-09-17T00:00:00.000Z",
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
  return { inLibrary, path: join(home, "state.json") };
});

it.effect("refuses to publish a state its own loader would reject", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { inLibrary, path } = yield* library;
    const before = yield* fs.readFileString(path);
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const state = yield* store.load;

    // Duplicate Collection IDs satisfy the state schema but not the portable manifest.
    const error = yield* store
      .publish({ ...state, collections: [...state.collections, ...state.collections] })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "InvalidLibraryState");
    assert.strictEqual(yield* fs.readFileString(path), before);
    assert.deepStrictEqual(yield* store.load, state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
