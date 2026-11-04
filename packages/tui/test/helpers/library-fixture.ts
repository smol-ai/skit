import { Library, LibraryActor, skitConfigurationLayer, skitLayer } from "@smolai/skit-core";
import { join } from "node:path";
import { Effect, FileSystem, Layer } from "effect";
import { deterministicTreeHash, LinkStat, makeMachineId } from "@smolai/skit-core";
import {
  confirmLibraryChange,
  openLibrarySession,
  proposeLibraryCollectionChange,
  type Scope,
} from "@smolai/skit-core/library/session";
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
  /** The Library as a second front end opens it: its own owner over the same home. */
  const owner = Library.layer({ home: skitHome, routing: { _tag: "None" } });
  const importSource = (collection: string, skills: readonly string[]) =>
    Effect.gen(function* () {
      const source = join(root, "sources", collection);
      for (const skill of skills) {
        yield* fs.makeDirectory(join(source, skill), { recursive: true });
        yield* fs.writeFileString(join(source, skill, "SKILL.md"), `${skill}\n`);
      }
      const skillRequests = yield* Effect.forEach(skills, (skill) =>
        Effect.map(deterministicTreeHash(join(source, skill)), (currentHash) => ({
          name: skill,
          sourcePath: join(source, skill),
          relativePath: skill,
          currentHash,
        })),
      );
      return yield* Effect.flatMap(Library.Service, (library) =>
        library.import.collection({
          source: { type: "local", path: source },
          input: source,
          importedAt: "2026-10-14T00:00:00.000Z",
          skills: skillRequests,
          lockFileEntries: [],
        }),
      ).pipe(Effect.provide(owner));
    });
  for (const [collection, skills] of Object.entries(collections))
    yield* importSource(collection, skills);
  const configuration = {
    home,
    configHome: join(home, ".config"),
    statePath: join(skitHome, "state.json"),
    variantsPath: join(skitHome, "variants"),
    overrides: {},
    now: () => "2026-10-14T00:00:00.000Z",
  };
  const application = Library.layer({ home: skitHome, routing: { _tag: "None" } }).pipe(
    Layer.provideMerge(skitLayer),
    Layer.provideMerge(skitConfigurationLayer(skitHome)),
    Layer.provideMerge(Layer.succeed(LibraryActor)("tui")),
  );
  return {
    root,
    home,
    skitHome,
    cwd,
    /** Retain another Collection, as a second front end writing to the same Library would. */
    retain: importSource,
    /** The installed-skill options the TUI derives from its flags for this home. */
    configuration,
    /** Enable a whole Collection in `scopes` through the session workflows the TUI confirms. */
    bind: (label: string, scopes: readonly Scope[]) =>
      Effect.gen(function* () {
        const session = yield* openLibrarySession(skitHome, configuration);
        const collectionId = session.skills.find((row) => row.heading === label)!.collectionId;
        const confirmed = yield* confirmLibraryChange(
          yield* proposeLibraryCollectionChange(session, configuration, collectionId, true, scopes),
        );
        if (confirmed.outcome?.kind !== "applied")
          return yield* Effect.die(`binding ${label} was ${confirmed.outcome?.kind}`);
        return collectionId;
      }).pipe(Effect.provide(application)),
    /** The Library's saved state, read through its owner. */
    durable: Effect.flatMap(Library.Service, (library) => library.read).pipe(
      Effect.flatMap((snapshot) =>
        snapshot._tag === "Present"
          ? Effect.succeed(snapshot.state)
          : Effect.die("the fixture Library has no state.json"),
      ),
      Effect.provide(owner),
    ),
    /** The host the TUI builds for this Library, over the production application layer. */
    host: () => createLibraryHost(application, openLibrarySession(skitHome, configuration)),
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
