import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Ref } from "effect";
import { join } from "node:path";
import { libraryStoreLayer, LibraryStore, retainedTreePath, skitLayer } from "@smolai/skit-core";
import { checkCollectionsEffect } from "../src/workflows/library/check.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";

it.effect("checks retained custody without treating an observed local copy as an upstream", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-check-" });
    const home = join(workspace, "library");
    const source = join(workspace, "raw-review");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(join(source, "SKILL.md"), "observed raw Skill\n");
    const retained = yield* addLibrarySourceEffect({}, source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    const loaded = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(loaded.present, true);
    if (!loaded.present) return;
    const checkedCollections = yield* Ref.make<ReadonlyArray<string>>([]);
    const current = yield* checkCollectionsEffect(
      loaded.state,
      {},
      retained.collection_id,
      (collection) =>
        Ref.update(checkedCollections, (names) => [...names, collection.display_name]),
    ).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(loaded.state),
        inspect: Effect.succeed(loaded),
        publish: () => Effect.void,
        snapshot: Effect.succeed(undefined),
        recordChangesSince: () => Effect.void,
        home,
        originalsPath: join(home, "originals"),
      }),
    );
    assert.strictEqual(current[0]?.retained_copies[0]?.retained_bytes_current, true);
    assert.deepStrictEqual(yield* Ref.get(checkedCollections), []);
    assert.strictEqual(current[0]?.source_status, "not-applicable");
    assert.strictEqual(current[0]?.available_snapshot_digest, undefined);
    yield* fs.writeFileString(join(source, "SKILL.md"), "changed source bytes\n");
    const path = retainedTreePath(join(home, "originals"), loaded.state.retained_copies[0]!.digest);
    yield* fs.writeFileString(join(path, "SKILL.md"), "changed retained bytes\n");
    const changed = yield* checkCollectionsEffect(loaded.state, {}, retained.collection_id).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(loaded.state),
        inspect: Effect.succeed(loaded),
        publish: () => Effect.void,
        snapshot: Effect.succeed(undefined),
        recordChangesSince: () => Effect.void,
        home,
        originalsPath: join(home, "originals"),
      }),
    );
    assert.strictEqual(changed[0]?.retained_copies[0]?.retained_bytes_current, false);
    assert.strictEqual(changed[0]?.source_status, "not-applicable");
    assert.strictEqual(changed[0]?.available_snapshot_digest, undefined);
    yield* fs.remove(source, { recursive: true });
    const withoutObservedCopy = yield* checkCollectionsEffect(
      loaded.state,
      {},
      retained.collection_id,
    ).pipe(
      Effect.provideService(LibraryStore, {
        load: Effect.succeed(loaded.state),
        inspect: Effect.succeed(loaded),
        publish: () => Effect.void,
        snapshot: Effect.succeed(undefined),
        recordChangesSince: () => Effect.void,
        home,
        originalsPath: join(home, "originals"),
      }),
    );
    assert.strictEqual(withoutObservedCopy[0]?.source_status, "not-applicable");
    assert.strictEqual(
      withoutObservedCopy[0]?.current_snapshot_digest,
      loaded.state.retained_copies[0]!.digest,
    );
    assert.strictEqual(withoutObservedCopy[0]?.available_snapshot_digest, undefined);
    const reloaded = yield* Effect.flatMap(LibraryStore, (store) => store.inspect).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(reloaded.present, true);
    if (!reloaded.present) return;
    assert.deepStrictEqual(
      reloaded.state.retained_copies[0]?.digest,
      loaded.state.retained_copies[0]?.digest,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
