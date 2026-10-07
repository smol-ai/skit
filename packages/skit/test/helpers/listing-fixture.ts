import { Context, Effect, FileSystem, Layer } from "effect";
import { libraryStoreLayer, makeMachineId, skitLayer } from "../../src/index.js";
import { join } from "node:path";
export class NativeLibraryFixture extends Context.Service<
  NativeLibraryFixture,
  {
    readonly root: string;
    readonly home: string;
  }
>()("test/ListingFixture") {}
const fixtureLayer = Layer.effect(
  NativeLibraryFixture,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-listing-" });
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
    return { root, home };
  }),
);
export const nativeLibraryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fixture = yield* NativeLibraryFixture;
    return libraryStoreLayer({ home: fixture.home });
  }),
).pipe(Layer.provideMerge(fixtureLayer), Layer.provideMerge(skitLayer));
