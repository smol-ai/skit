import { Context, Effect, FileSystem, Layer } from "effect";
import { libraryStoreLayer, makeMachineId, skitLayer, treeHasherLayer } from "@smolai/skit-core";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetentionOptions } from "../../src/workflows/library/retention-options.js";
import type { ProjectionOptions } from "../../src/workflows/library/projection-options.js";

export class NativeLibraryFixture extends Context.Service<
  NativeLibraryFixture,
  {
    readonly root: string;
    readonly source: string;
    readonly home: string;
    readonly addOptions: RetentionOptions;
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
      addOptions: {
        installation: {
          statePath: join(home, "state.json"),
          variantsPath: join(home, "variants"),
          rootFor: () => undefined,
        },
        originalsPath: join(home, "originals"),
      },
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

export const nativeBindingConfiguration = (fixture: {
  root: string;
  home: string;
}): ProjectionOptions => ({
  home: fixture.root,
  configHome: join(fixture.root, "config"),
  statePath: join(fixture.home, "state.json"),
  variantsPath: join(fixture.home, "variants"),
  overrides: {
    codex: join(fixture.root, "codex"),
    claude: join(fixture.root, "claude"),
    opencode: join(fixture.root, "opencode"),
    devin: [join(fixture.root, "devin")],
  },
});
