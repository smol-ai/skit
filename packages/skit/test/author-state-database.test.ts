import * as History from "../src/history/history.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import * as Sync from "../src/sync/sync.js";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { WorkspaceId } from "../src/author/workspace-contracts.js";
import {
  prepareAuthorState,
  readAuthorSyncState,
  readAuthorBackup,
  readAuthorInventory,
  withAuthorStateTransaction,
  saveAuthorSyncState,
} from "../src/author/state-store.js";
import {
  libraryDatabasePath,
  withLibraryDatabase,
  prepareLibraryDatabase,
} from "../src/library/store/database.js";
import { skitLayer } from "../src/platform/layer.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import { withLock } from "../src/platform/home-lock.js";

it.effect(
  "Author imports released checkpoints losslessly and reads individual rows without legacy files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-state-" });
      const a = WorkspaceId.make(`workspace_${"a".repeat(32)}`);
      const b = WorkspaceId.make(`workspace_${"b".repeat(32)}`);
      const c = WorkspaceId.make(`workspace_${"c".repeat(32)}`);
      const hash = `sha256:${"d".repeat(64)}`;
      const idle = yield* Schema.decodeUnknownEffect(Schema.declare(Schema.is(Sync.Idle)))({
        _tag: "Idle",
        base: null,
      });
      const writing = yield* Schema.decodeUnknownEffect(Schema.declare(Schema.is(Sync.Writing)))({
        _tag: "Writing",
        base: null,
        from: hash,
        to: hash,
        merged: false,
        next: { _tag: "Sending", base: null, revision: hash },
      });
      const inventory = {
        inventory: { files: ["b", "a", "a"], members: ["m2", "m1"] },
        removedFiles: ["removed"],
        removedMembers: [],
      };
      const document = {
        schema: "skit.author-sync.v1",
        workspaces: { [a]: { one: idle }, [b]: {}, [c]: { writing } },
        inventories: { [a]: inventory },
        backups: { [a]: { one: hash }, [b]: {} },
      };
      const text = `${JSON.stringify(document, null, 2)}\n`;
      const source = join(home, "author-sync.json");
      yield* fs.writeFileString(source, text);
      assert.isTrue(yield* prepareAuthorState(home));
      assert.strictEqual(yield* fs.readFileString(`${source}.backup-database`), text);
      assert.strictEqual(yield* fs.readFileString(source), text);
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: a, locator: "one" }),
        idle,
      );
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: c, locator: "writing" }),
        writing,
      );
      assert.deepStrictEqual(yield* readAuthorInventory(home, a), inventory);
      assert.strictEqual(yield* readAuthorBackup(home, { workspaceId: a, locator: "one" }), hash);
      assert.isUndefined(yield* readAuthorInventory(home, b));
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT document FROM author_state_import`, [
            { document: text },
          ]);
          assert.deepStrictEqual(
            yield* sql`SELECT inventories_present,backups_present FROM author_state_fields`,
            [
              {
                inventories_present: 1,
                backups_present: 1,
              },
            ],
          );
          assert.deepStrictEqual(
            yield* sql`SELECT sync_present,backup_present FROM author_workspace_state WHERE workspace_id=${b}`,
            [{ sync_present: 1, backup_present: 1 }],
          );
          assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM machine`, [{ n: 0 }]);
          assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM library_device`, [{ n: 0 }]);
        }),
        true,
      );
      // Current reads and mutations use rows alone. The exact original remains archived in SQLite.
      yield* fs.remove(source);
      yield* fs.remove(`${source}.backup-database`);
      yield* withAuthorStateTransaction(
        home,
        saveAuthorSyncState(home, { workspaceId: a, locator: "two" }, { _tag: "Idle", base: null }),
      );
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: c, locator: "writing" }),
        writing,
      );
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: a, locator: "one" }),
        idle,
      );
      assert.deepStrictEqual(yield* readAuthorInventory(home, a), inventory);
      const nativeRevision = yield* History.RevisionId.makeEffect(hash);
      // Declared checkpoint fields round-trip across native transitions; source evidence remains exact.
      yield* withAuthorStateTransaction(
        home,
        saveAuthorSyncState(
          home,
          { workspaceId: a, locator: "one" },
          {
            _tag: "Sending",
            base: null,
            revision: nativeRevision,
          },
        ),
      );
      assert.deepStrictEqual(yield* readAuthorSyncState(home, { workspaceId: a, locator: "one" }), {
        ...idle,
        _tag: "Sending",
        revision: nativeRevision,
      });
      yield* withAuthorStateTransaction(
        home,
        saveAuthorSyncState(home, { workspaceId: a, locator: "one" }, { _tag: "Idle", base: null }),
      );
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: a, locator: "one" }),
        idle,
      );
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE author_inventory_paths`;
          yield* sql`DROP TABLE author_inventories`;
          yield* sql`DROP TABLE author_backup_checkpoints`;
        }),
      );
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: a, locator: "one" }),
        idle,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author refuses changed legacy input after import without changing accepted rows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-fenced-" });
    const source = join(home, "author-sync.json");
    const original = '{"schema":"skit.author-sync.v1","workspaces":{}}';
    yield* fs.writeFileString(source, original);
    yield* prepareAuthorState(home);
    yield* fs.writeFileString(source, `${original}\n`);
    const failure = yield* Effect.flip(prepareAuthorState(home, { checkLegacy: true }));
    assert.strictEqual(failure._tag, "AuthorHistoryInvalid");
    assert.strictEqual(yield* fs.readFileString(`${source}.backup-database`), original);
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT document FROM author_state_import`, [
          { document: original },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM author_sync_checkpoints`, [
          { n: 0 },
        ]);
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Author checkpoint and Machine Settings writes commit and roll back together", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-shared-transaction-" });
    yield* prepareAuthorState(home, { create: true });
    const key = {
      workspaceId: WorkspaceId.make(`workspace_${"f".repeat(32)}`),
      locator: "skit://fixture/one/two",
    };
    const checkpoint = { _tag: "Idle" as const, base: null };
    const changes = Effect.gen(function* () {
      yield* saveAuthorSyncState(home, key, checkpoint);
      yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/fixture/project"] });
    });
    const stopped = { _tag: "FixtureRollback" as const };
    assert.strictEqual(
      yield* Effect.flip(
        withLock(
          home,
          withAuthorStateTransaction(home, changes.pipe(Effect.andThen(Effect.fail(stopped)))),
        ),
      ),
      stopped,
    );
    const prior = yield* MachineSettings.read(home);
    assert.isUndefined(prior.machineId);
    assert.deepStrictEqual(prior.discoveryRoots, []);
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM author_sync_checkpoints`, [
          { n: 0 },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM machine`, [{ n: 0 }]);
      }),
      true,
    );
    yield* withLock(home, withAuthorStateTransaction(home, changes));
    assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, [
      "/fixture/project",
    ]);
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT workspace_id,locator FROM author_sync_checkpoints`,
          [{ workspace_id: key.workspaceId, locator: key.locator }],
        );
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a refused Author import leaves the source and backup intact and rolls back all imported rows",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-import-rollback-" });
      const source = join(home, "author-sync.json");
      const id = WorkspaceId.make(`workspace_${"e".repeat(32)}`);
      const text = JSON.stringify({
        schema: "skit.author-sync.v1",
        workspaces: { [id]: { one: { _tag: "Idle", base: null } } },
      });
      yield* fs.writeFileString(source, text);
      // Create only the shared schema so the import can be faulted at its final publication.
      yield* prepareLibraryDatabase(home, true);
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_author_import BEFORE INSERT ON author_state_import BEGIN SELECT RAISE(ABORT,'fixture refuses import'); END`;
        }),
      );
      assert.strictEqual(
        (yield* Effect.flip(prepareAuthorState(home)))._tag,
        "AuthorHistoryInvalid",
      );
      assert.strictEqual(yield* fs.readFileString(source), text);
      assert.strictEqual(yield* fs.readFileString(`${source}.backup-database`), text);
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM author_sync_checkpoints`, [
            { n: 0 },
          ]);
          assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM author_state_fields`, [
            { n: 0 },
          ]);
          assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM author_state_import`, [
            { n: 0 },
          ]);
          yield* sql`DROP TRIGGER refuse_author_import`;
        }),
      );
      yield* prepareAuthorState(home);
      assert.deepStrictEqual(
        yield* readAuthorSyncState(home, { workspaceId: id, locator: "one" }),
        { _tag: "Idle", base: null },
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "an unrecognized native inventory category is reported rather than silently omitted",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-corrupt-category-" });
      const workspace = WorkspaceId.make(`workspace_${"a".repeat(32)}`);
      yield* prepareAuthorState(home, { create: true });
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO author_workspace_state VALUES(${workspace},0,0)`;
          yield* sql`INSERT INTO author_inventories(workspace_id) VALUES(${workspace})`;
          yield* sql`PRAGMA ignore_check_constraints=ON`;
          yield* sql`INSERT INTO author_inventory_paths VALUES(${workspace},'future-category',0,'unread-data')`;
          yield* sql`PRAGMA ignore_check_constraints=OFF`;
        }),
      );
      const error = yield* Effect.flip(readAuthorInventory(home, workspace));
      assert.strictEqual(error._tag, "AuthorSyncStateInvalid");
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT category,path FROM author_inventory_paths`, [
            { category: "future-category", path: "unread-data" },
          ]);
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "unknown Author source and checkpoint fields are refused without losing original data",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-excess-" });
      const source = join(home, "author-sync.json");
      const text =
        ' {"schema":"skit.author-sync.v1","workspaces":{},"future":{"kept":[null,false]}} \n';
      yield* fs.writeFileString(source, text);
      const refused = yield* Effect.result(prepareAuthorState(home));
      assert.strictEqual(refused._tag, "Failure");
      assert.strictEqual(yield* fs.readFileString(source), text);
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_state_import`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_sync_checkpoints`, []);
        }),
        true,
      );
      yield* fs.remove(source);
      const key = { workspaceId: WorkspaceId.make("workspace_" + "a".repeat(32)), locator: "one" };
      const unknown = { ...Sync.Idle.make({ base: null }), future: { kept: [null, false] } };
      const written = yield* Effect.result(
        withAuthorStateTransaction(home, saveAuthorSyncState(home, key, unknown)),
      );
      assert.strictEqual(written._tag, "Failure");
      assert.deepStrictEqual(yield* readAuthorSyncState(home, key), Sync.Idle.make({ base: null }));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
