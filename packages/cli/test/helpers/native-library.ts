import { Context, Effect, FileSystem, Layer } from "effect";
import { libraryStoreLayer, makeMachineId, skitLayer, treeHasherLayer } from "@smolai/skit-core";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class NativeLibraryFixture extends Context.Service<
  NativeLibraryFixture,
  {
    readonly root: string;
    readonly source: string;
    readonly home: string;
  }
>()("test/NativeLibraryFixture") {}

const fixtureLayer = Layer.effect(
  NativeLibraryFixture,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-native-library-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(home, { recursive: true });
    yield* fs.writeFileString(
      join(home, "machine.json"),
      JSON.stringify({
        schemaVersion: 3,
        machineId: makeMachineId(),
        displayName: "Test machine",
        repositoryRoots: [],
      }),
    );
    yield* fs.copy(fileURLToPath(new URL("../fixtures/library", import.meta.url)), source);
    return {
      root,
      source,
      home,
    };
  }),
);

export const nativeLibraryResources = Layer.unwrap(
  Effect.gen(function* () {
    const fixture = yield* NativeLibraryFixture;
    return Layer.merge(libraryStoreLayer({ home: fixture.home }), treeHasherLayer);
  }),
).pipe(Layer.provideMerge(fixtureLayer));

export const nativeLibraryLayer = nativeLibraryResources.pipe(Layer.provideMerge(skitLayer));
