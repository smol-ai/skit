import type { PlatformError } from "effect/PlatformError";
import { LinkStat } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import {
  confirmLibraryChange,
  proposeLibraryCollectionChange,
  type InstallScope,
} from "@smolai/skit-core/library/session";
import { createLibraryHost } from "../../src/library/host";

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
  const deviceRoots = { home, configHome: join(home, ".config"), overrides: {} };
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
  const owner = Library.layer({ home: skitHome, roots: deviceRoots });
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
  const application = Library.layer({ home: skitHome, roots: deviceRoots }).pipe(
    Layer.provideMerge(skitLayer),
    Layer.provideMerge(skitConfigurationLayer(skitHome)),
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
    bind: (label: string, scopes: readonly InstallScope[]) =>
      Effect.gen(function* () {
        const session = yield* Effect.flatMap(Library.Service, (library) => library.session.open());
        const collectionId = session.skills.find((row) => row.heading === label)!.collectionId;
        const confirmed = yield* confirmLibraryChange(
          yield* proposeLibraryCollectionChange(session, collectionId, true, scopes),
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
    host: () =>
      createLibraryHost(
        application,
        Effect.flatMap(Library.Service, (library) => library.session.open()),
      ),
    /** Every durable path: type, mode, link target and bytes, or all SQLite schema/row values.
     * WAL/SHM are coordination files; committed rows in a WAL still enter the SQL snapshot. */
    tree: Effect.gen(function* () {
      const links = yield* LinkStat;
      const entries = new Map<string, string>();
      const walk = (path: string): Effect.Effect<void, PlatformError | Schema.SchemaError> =>
        Effect.gen(function* () {
          if (
            path === join(skitHome, "library.sqlite-wal") ||
            path === join(skitHome, "library.sqlite-shm")
          )
            return;
          const info = yield* links.lstat(path);
          if (info.type === "SymbolicLink")
            entries.set(path, `link ${info.mode} ${yield* fs.readLink(path)}`);
          else if (info.type === "Directory") {
            entries.set(path, `directory ${info.mode}`);
            for (const name of yield* fs.readDirectory(path)) yield* walk(join(path, name));
          } else if (path === join(skitHome, "library.sqlite")) {
            const saved = yield* Effect.acquireUseRelease(
              Effect.sync(() => new DatabaseSync(path, { readOnly: true })),
              (database) =>
                Effect.gen(function* () {
                  database.exec("BEGIN");
                  const tables = yield* Schema.decodeUnknownEffect(
                    Schema.Array(
                      Schema.Struct({
                        name: Schema.String,
                        sql: Schema.String,
                      }),
                    ),
                  )(
                    database
                      .prepare(
                        "SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name",
                      )
                      .all(),
                  );
                  return tables.map((table) => ({
                    ...table,
                    rows: database
                      .prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
                      .all(),
                  }));
                }),
              (database) => Effect.sync(() => database.close()),
            );
            entries.set(path, `database ${info.mode} ${JSON.stringify(saved)}`);
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
