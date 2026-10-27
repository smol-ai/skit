import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";
import {
  deterministicTreeHash,
  libraryStoreLayer,
  LibraryStore,
  LinkStat,
  makeMachineId,
  importCollection,
  withLibraryWriter,
} from "@smolai/skit-core";
import {
  confirmLibraryChange,
  LibraryActor,
  libraryApplicationLayer,
  openLibrarySession,
  proposeLibraryCollectionChange,
  skitConfigurationLayer,
  type Scope,
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
        importCollection({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-14T00:00:00.000Z",
          skills: yield* Effect.forEach(skills, (skill) =>
            Effect.map(deterministicTreeHash(join(source, skill)), (observedHash) => ({
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
  const configuration = {
    home,
    configHome: join(home, ".config"),
    statePath: join(skitHome, "state.json"),
    variantsPath: join(skitHome, "variants"),
    overrides: {},
    now: () => "2026-10-14T00:00:00.000Z",
  };
  const application = libraryApplicationLayer.pipe(
    Layer.provideMerge(skitConfigurationLayer(skitHome)),
    Layer.provideMerge(Layer.succeed(LibraryActor)("tui")),
  );
  return {
    root,
    home,
    skitHome,
    cwd,
    /** Retain another Collection, as a second front end writing to the same Library would. */
    retain,
    /** The installed-skill options the TUI derives from its flags for this home. */
    configuration,
    /** Enable a whole Collection in `scopes` through the session workflows the TUI confirms. */
    bind: (label: string, scopes: readonly Scope[]) =>
      Effect.gen(function* () {
        const session = yield* openLibrarySession();
        const collectionId = session.skills.find((row) => row.heading === label)!.collectionId;
        const confirmed = yield* confirmLibraryChange(
          yield* proposeLibraryCollectionChange(session, configuration, collectionId, true, scopes),
        );
        if (confirmed.outcome?.kind !== "applied")
          return yield* Effect.die(`binding ${label} was ${confirmed.outcome?.kind}`);
        return collectionId;
      }).pipe(Effect.provide(application)),
    durable: Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home: skitHome })),
    ),
    /** The host the TUI builds for this Library, over the production application layer. */
    host: () => createLibraryHost(application, openLibrarySession()),
    /** Every path under the fixture, by lstat: its type, mode, link target and bytes. */
    tree: Effect.gen(function* () {
      const links = yield* LinkStat;
      const entries = new Map<string, string>();
      const walk = (path: string): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          const info = yield* links.lstat(path);
          if (info.type === "SymbolicLink")
            entries.set(path, `link ${info.mode} ${yield* fs.readLink(path)}`);
          else if (info.type === "Directory") {
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
