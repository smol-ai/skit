import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Ref } from "effect";
import { join } from "node:path";
import {
  libraryStoreLayer,
  LibraryStore,
  collectionVersionPath,
  skitLayer,
} from "@smolai/skit-core";
import { checkSubjects } from "../src/workflows/library/check.js";
import { importSource } from "../src/library-application/import-source.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";

it.effect("checks retained files without treating an observed local copy as an upstream", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-check-" });
    const home = join(workspace, "library");
    const source = join(workspace, "raw-review");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(join(source, "SKILL.md"), "observed raw Skill\n");
    const retained = yield* importSource(source).pipe(Effect.provide(libraryStoreLayer({ home })));
    const loaded = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(loaded.present, true);
    if (!loaded.present) return;
    const checkedCollections = yield* Ref.make<ReadonlyArray<string>>([]);
    const current = yield* checkSubjects(loaded.state, retained.collection_id, (collection) =>
      Ref.update(checkedCollections, (names) => [...names, collection.display_name]),
    ).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(loaded.state),
        inspect: Effect.succeed(loaded),
        save: () => Effect.void,
        home,
        originalsPath: join(home, "originals"),
        statePath: join(home, "state.json"),
        variantsPath: join(home, "variants"),
      }),
    );
    assert.strictEqual(current[0]?.collection_versions[0]?.original_intact, true);
    assert.deepStrictEqual(yield* Ref.get(checkedCollections), []);
    assert.strictEqual(current[0]?.source_status, "not-applicable");
    assert.strictEqual(current[0]?.available_snapshot_digest, undefined);
    yield* fs.writeFileString(join(source, "SKILL.md"), "changed source bytes\n");
    const path = collectionVersionPath(
      join(home, "originals"),
      loaded.state.collection_versions[0]!.digest,
    );
    yield* fs.writeFileString(join(path, "SKILL.md"), "changed retained bytes\n");
    const changed = yield* checkSubjects(loaded.state, retained.collection_id).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(loaded.state),
        inspect: Effect.succeed(loaded),
        save: () => Effect.void,
        home,
        originalsPath: join(home, "originals"),
        statePath: join(home, "state.json"),
        variantsPath: join(home, "variants"),
      }),
    );
    assert.strictEqual(changed[0]?.collection_versions[0]?.original_intact, false);
    assert.strictEqual(changed[0]?.source_status, "not-applicable");
    assert.strictEqual(changed[0]?.available_snapshot_digest, undefined);
    yield* fs.remove(source, { recursive: true });
    const withoutObservedCopy = yield* checkSubjects(loaded.state, retained.collection_id).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(loaded.state),
        inspect: Effect.succeed(loaded),
        save: () => Effect.void,
        home,
        originalsPath: join(home, "originals"),
        statePath: join(home, "state.json"),
        variantsPath: join(home, "variants"),
      }),
    );
    assert.strictEqual(withoutObservedCopy[0]?.source_status, "not-applicable");
    assert.strictEqual(
      withoutObservedCopy[0]?.current_snapshot_digest,
      loaded.state.collection_versions[0]!.digest,
    );
    assert.strictEqual(withoutObservedCopy[0]?.available_snapshot_digest, undefined);
    const reloaded = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(reloaded.present, true);
    if (!reloaded.present) return;
    assert.deepStrictEqual(
      reloaded.state.collection_versions[0]?.digest,
      loaded.state.collection_versions[0]?.digest,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
