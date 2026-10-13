import { join } from "node:path";
import { Effect, FileSystem, Layer, Result } from "effect";
import {
  deterministicTreeHashEffect,
  libraryStoreLayer,
  LibraryStore,
  makeMachineId,
  retainObservedCollectionEffect,
  withLibraryWriter,
} from "@smolai/skit-core";
import {
  LibraryActor,
  libraryApplicationLayer,
  openLibrarySession,
  skitConfigurationLayer,
} from "../../../cli/src/front-end";
import { createLibraryHost } from "../../src/library-host";

/**
 * A temporary user home holding a Library at `<home>/.skit`, one retained local Collection per
 * entry of `collections`, and nothing else. Every path the TUI may touch lives under `root`.
 */
export const tuiLibrary = Effect.fn("Test.tuiLibrary")(function* (
  collections: Record<string, readonly string[]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-tui-" });
  const home = join(root, "home");
  const skitHome = join(home, ".skit");
  const cwd = join(root, "work");
  yield* fs.makeDirectory(skitHome, { recursive: true });
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* fs.writeFileString(
    join(skitHome, "machine.json"),
    JSON.stringify({
      schemaVersion: 3,
      machineId: makeMachineId(),
      displayName: "Test machine",
      repositoryRoots: [],
    }),
  );
  const retain = (collection: string, skills: readonly string[]) =>
    Effect.gen(function* () {
      const source = join(root, "sources", collection);
      for (const skill of skills) {
        yield* fs.makeDirectory(join(source, skill), { recursive: true });
        yield* fs.writeFileString(join(source, skill, "SKILL.md"), `${skill}\n`);
      }
      return yield* withLibraryWriter(
        retainObservedCollectionEffect({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-14T00:00:00.000Z",
          skills: yield* Effect.forEach(skills, (skill) =>
            Effect.map(deterministicTreeHashEffect(join(source, skill)), (observedHash) => ({
              name: skill,
              sourcePath: join(source, skill),
              relativePath: skill,
              observedHash,
            })),
          ),
          observations: [],
        }),
      ).pipe(Effect.provide(libraryStoreLayer({ home: skitHome })));
    });
  for (const [collection, skills] of Object.entries(collections)) yield* retain(collection, skills);
  return {
    root,
    home,
    skitHome,
    cwd,
    /** Retain another Collection, as a second front end writing to the same Library would. */
    retain,
    /** The projection options the TUI derives from its flags for this home. */
    configuration: {
      home,
      configHome: join(home, ".config"),
      statePath: join(skitHome, "state.json"),
      variantsPath: join(skitHome, "variants"),
      overrides: {},
      now: () => "2026-10-14T00:00:00.000Z",
    },
    durable: Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home: skitHome })),
    ),
    /** The host the TUI builds for this Library, over the production application layer. */
    host: () =>
      createLibraryHost(
        libraryApplicationLayer.pipe(
          Layer.provideMerge(skitConfigurationLayer(skitHome)),
          Layer.provideMerge(Layer.succeed(LibraryActor)("tui")),
        ),
        openLibrarySession(),
      ),
    /** Every path under the fixture with its type, mode, link target and bytes, lstat-based. */
    tree: Effect.gen(function* () {
      const entries = new Map<string, string>();
      const walk = (path: string): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          const link = yield* Effect.result(fs.readLink(path));
          if (Result.isSuccess(link)) {
            entries.set(path, `link ${link.success}`);
            return;
          }
          const info = yield* fs.stat(path);
          if (info.type === "Directory") {
            entries.set(path, `directory ${info.mode}`);
            for (const name of yield* fs.readDirectory(path)) yield* walk(join(path, name));
          } else
            entries.set(
              path,
              `${info.type} ${info.mode} ${Buffer.from(yield* fs.readFile(path)).toString("base64")}`,
            );
        });
      yield* walk(root);
      return entries;
    }),
  };
});
