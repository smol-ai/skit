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

const emptyV9 = {
  schemaVersion: 9,
  unmanaged: [],
  collections: [],
  skills: [],
  retained_copies: [],
  acquisitions: [],
  global_bindings: [],
  local_bindings: [],
  projections: [],
};

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
      const state = { ...emptyLibraryState() };
      yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(emptyV9));
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
      const state = { ...emptyLibraryState() };
      yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(emptyV9));
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
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(emptyV9));
    yield* migrateLocalLibraryState(home);
    const before = yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/saved"] });
    yield* withDatabaseTransaction(
      home,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA ignore_check_constraints=ON`;
        yield* sql`UPDATE library_device SET schema_version=99 WHERE id=1`;
        yield* sql`PRAGMA ignore_check_constraints=OFF`;
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
  "v5 imports preserve duplicates, order, declared JSON and key presence exactly, and import only once",
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
          { path: "/same", status: "watched" },
          { path: "/same", status: "ignored" },
        ],
        repositoryDecisionsInitialized: true,
        legacyMachineId: { future: true },
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
            yield* sql`SELECT position,path,status FROM machine_repositories ORDER BY position`,
            machine.repositories.map(({ path, status }, position) => ({
              position,
              path,
              status,
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

for (const nested of [false, true])
  it.effect(
    `unknown Machine fields refuse import without changing source evidence (nested=${nested})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-excess-" });
        const document = {
          schemaVersion: 5,
          discoveryRoots: [],
          repositoryDecisionsInitialized: true,
          repositories: nested
            ? [{ path: "/same", status: "watched", future: { kept: [null, false] } }]
            : [],
          ...(nested ? {} : { future: { kept: [null, false] } }),
        };
        const text = JSON.stringify(document, null, 2) + "\n";
        const source = join(home, "machine.json");
        yield* fs.writeFileString(source, text);
        const result = yield* Effect.result(MachineSettings.read(home));
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(yield* fs.readFileString(source), text);
        yield* withLibraryDatabase(
          libraryDatabasePath(home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* sql`SELECT * FROM machine`, []);
            assert.deepStrictEqual(yield* sql`SELECT * FROM machine_repositories`, []);
            assert.deepStrictEqual(
              yield* sql`SELECT * FROM library_import WHERE source='machine.json'`,
              [],
            );
          }),
          true,
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

for (const rollback of ["transaction", "savepoint"]) {
  it.effect(`machine import recovers from its durable backup when its ${rollback} rolls back`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-rollback-" });
      const source = join(home, "machine.json");
      const lock = join(home, ".lock");
      const path = libraryDatabasePath(home);
      const original = JSON.stringify({
        schemaVersion: 5,
        machineId: makeMachineId(),
        displayName: "Before rollback",
        discoveryRoots: ["/original"],
        repositories: [],
        repositoryDecisionsInitialized: false,
      });
      yield* fs.writeFileString(source, original);
      const updateAndFail = Effect.gen(function* () {
        yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/uncommitted"] });
        assert.strictEqual(yield* fs.readFileString(source), '{"schemaVersion":6}\n');
        assert.isFalse(yield* fs.exists(lock));
        return yield* Effect.fail("roll back machine import");
      });
      if (rollback === "transaction") {
        assert.strictEqual(
          yield* Effect.flip(withDatabaseTransaction(home, updateAndFail)),
          "roll back machine import",
        );
      } else {
        yield* withDatabaseTransaction(
          home,
          Effect.gen(function* () {
            assert.strictEqual(
              yield* Effect.flip(withDatabaseTransaction(home, updateAndFail)),
              "roll back machine import",
            );
            assert.isFalse(yield* fs.exists(lock));
          }),
        );
      }

      assert.strictEqual(yield* fs.readFileString(source), '{"schemaVersion":6}\n');
      assert.isFalse(yield* fs.exists(lock));
      assert.strictEqual(yield* fs.readFileString(`${source}.backup-database`), original);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT id FROM machine`, []);
          assert.deepStrictEqual(
            yield* sql`SELECT source FROM library_import WHERE source='machine.json'`,
            [],
          );
        }),
        true,
      );
      assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, ["/original"]);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* loadMachineRows(path), JSON.parse(original));
          assert.deepStrictEqual(
            yield* sql`SELECT source,fenced FROM library_import WHERE source='machine.json'`,
            [{ source: "machine.json", fenced: 1 }],
          );
        }),
        true,
      );
      assert.strictEqual(yield* fs.readFileString(source), '{"schemaVersion":6}\n');
      assert.isFalse(yield* fs.exists(lock));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}
