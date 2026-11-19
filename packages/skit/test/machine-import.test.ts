import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import * as MachineSettings from "../src/library/machine-settings.js";
import * as Library from "../src/library/library.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import {
  libraryDatabasePath,
  withLibraryDatabase,
  withDatabaseTransaction,
} from "../src/library/store/database.js";
import { loadMachineRows } from "../src/library/store/machine-rows.js";
import {
  inspectLocalLibraryState,
  migrateLocalLibraryState,
} from "../src/library/store/state-file.js";
import { canonicalJson } from "../src/shared/json.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

it.effect(
  "machine imports independently of a corrupt legacy Library; repairing it imports into the same database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-independent-machine-" });
      const machine = {
        schemaVersion: 5,
        machineId: makeMachineId(),
        displayName: "Example",
        discoveryRoots: ["/saved"],
        repositories: [],
        repositoryDecisionsInitialized: false,
      };
      const bytes = JSON.stringify(machine);
      const corrupt = "not a Library document\n";
      yield* fs.writeFileString(join(home, "machine.json"), bytes);
      yield* fs.writeFileString(join(home, "state.json"), corrupt);
      assert.deepStrictEqual(
        (yield* MachineSettings.read(home)).discoveryRoots,
        machine.discoveryRoots,
      );
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT source FROM library_import`, [
            { source: "machine.json" },
          ]);
          assert.deepStrictEqual(yield* sql`SELECT id FROM library_device`, []);
        }),
        true,
      );
      assert.strictEqual(
        (yield* Effect.flip(migrateLocalLibraryState(home)))._tag,
        "InvalidLibraryState",
      );
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), corrupt);
      assert.strictEqual(
        yield* fs.readFileString(join(home, "machine.json.backup-database")),
        bytes,
      );
      const state = { ...emptyLibraryState(), extension: { keep: [null, {}, []] } };
      yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(state));
      yield* migrateLocalLibraryState(home);
      const loaded = yield* inspectLocalLibraryState(home);
      assert.isTrue(loaded.present);
      if (loaded.present) assert.strictEqual(canonicalJson(loaded.state), canonicalJson(state));
      assert.deepStrictEqual(
        (yield* MachineSettings.read(home)).discoveryRoots,
        machine.discoveryRoots,
      );
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT source,fenced FROM library_import ORDER BY source`,
            [
              { source: "audit.jsonl", fenced: 1 },
              { source: "machine.json", fenced: 1 },
              { source: "state.json", fenced: 1 },
            ],
          );
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a corrupt machine file does not block importing the Library, and can be imported after repair",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-independent-library-" });
      const state = { ...emptyLibraryState(), extension: { keep: [false, null] } };
      yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(state));
      yield* fs.writeFileString(join(home, "machine.json"), "invalid machine\n");
      yield* migrateLocalLibraryState(home);
      const loaded = yield* inspectLocalLibraryState(home);
      assert.isTrue(loaded.present);
      if (loaded.present) assert.strictEqual(canonicalJson(loaded.state), canonicalJson(state));
      assert.strictEqual(
        (yield* Effect.flip(MachineSettings.read(home)))._tag,
        "MachineSettingsUnusable",
      );
      assert.strictEqual(yield* fs.readFileString(join(home, "machine.json")), "invalid machine\n");
      const repaired = {
        schemaVersion: 5,
        machineId: makeMachineId(),
        displayName: "Repaired",
        discoveryRoots: [],
        repositories: [],
        repositoryDecisionsInitialized: false,
      };
      yield* fs.writeFileString(join(home, "machine.json"), JSON.stringify(repaired));
      assert.strictEqual((yield* MachineSettings.read(home)).machineId, repaired.machineId);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("invalid Library rows leave machine settings readable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-independent-rows-" });
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(emptyLibraryState()));
    yield* migrateLocalLibraryState(home);
    const before = yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/saved"] });
    yield* withDatabaseTransaction(
      home,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE library_device SET extra=json_set(COALESCE(extra,'{}'),'$.schemaVersion','corrupt') WHERE id=1`;
      }),
    );
    assert.strictEqual(
      (yield* Effect.flip(inspectLocalLibraryState(home)))._tag,
      "InvalidLibraryState",
    );
    assert.deepStrictEqual(yield* MachineSettings.read(home), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "v5 imports preserve duplicates, order, unknown fields and key presence exactly, and import only once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-lossless-" });
      const machine = {
        schemaVersion: 5,
        machineId: makeMachineId(),
        displayName: "Lossless",
        discoveryRoots: ["/second", "/first", "/second"],
        repositories: [
          { path: "/same", status: "watched", extension: { one: [null, {}] } },
          { path: "/same", status: "ignored", extension: { two: [] } },
        ],
        repositoryDecisionsInitialized: true,
        legacyMachineId: { future: true },
        path: { future: "data" },
        extension: { ["__proto__"]: { keep: true }, missing: null, empty: [] },
      };
      const text = JSON.stringify(machine);
      yield* fs.writeFileString(join(home, "machine.json"), text);
      yield* MachineSettings.read(home);
      yield* MachineSettings.read(home);
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const loaded = yield* loadMachineRows(path);
          assert.strictEqual(canonicalJson(loaded), canonicalJson(machine));
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT position,path,status,extra FROM machine_repositories ORDER BY position`,
            machine.repositories.map(({ path, status, ...extra }, position) => ({
              position,
              path,
              status,
              extra: JSON.stringify(extra),
            })),
          );

          assert.deepStrictEqual(yield* sql`SELECT source FROM library_import`, [
            { source: "machine.json" },
          ]);
        }),
        true,
      );
      yield* MachineSettings.updateDiscovery(home, { displayName: "Renamed" });
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const loaded = yield* loadMachineRows(path);
          assert.ok(loaded);
          const raw = JSON.parse(JSON.stringify(loaded));
          assert.deepStrictEqual(raw.extension, machine.extension);
          assert.deepStrictEqual(raw.path, machine.path);
          assert.deepStrictEqual(raw.legacyMachineId, machine.legacyMachineId);
        }),
        true,
      );
      assert.strictEqual(
        yield* fs.readFileString(join(home, "machine.json.backup-database")),
        text,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("each imported source refuses a changed leftover independently", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-leftover-" });
    const machine = {
      schemaVersion: 5,
      machineId: makeMachineId(),
      displayName: "Original",
      discoveryRoots: [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    };
    yield* fs.writeFileString(join(home, "machine.json"), JSON.stringify(machine));
    yield* MachineSettings.read(home);
    const edited = JSON.stringify({ ...machine, displayName: "Independent old writer" });
    yield* fs.writeFileString(join(home, "machine.json"), edited);
    const failure = yield* Effect.flip(MachineSettings.read(home));
    assert.strictEqual(failure._tag, "InvalidLibraryState");
    if (failure._tag === "InvalidLibraryState")
      assert.strictEqual(failure.reason._tag, "LegacySourceChanged");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.strictEqual((yield* library.read)._tag, "Absent");
    }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
    assert.strictEqual(yield* fs.readFileString(join(home, "machine.json")), edited);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retries from the durable backup if the refusal file precedes the SQLite commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-fence-retry-" });
    const source = join(home, "machine.json");
    const original = JSON.stringify({ schemaVersion: 1, repositoryRoots: ["/preserved"] });
    yield* fs.writeFileString(source, original);
    const interrupted = yield* MachineSettings.read(home).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        open: (path, options) =>
          path === source
            ? Effect.fail(
                systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "open",
                  pathOrDescriptor: path,
                  cause: new Error("fixture failure after fencing"),
                }),
              )
            : fs.open(path, options),
      }),
      Effect.flip,
    );
    assert.strictEqual(interrupted._tag, "PlatformError");
    assert.strictEqual(yield* fs.readFileString(`${source}.backup-database`), original);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(source)), { schemaVersion: 6 });
    assert.isUndefined(
      yield* withLibraryDatabase(libraryDatabasePath(home), loadMachineRows(source), true),
    );
    assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, ["/preserved"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
