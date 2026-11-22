import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import * as Sync from "../src/sync/sync.js";
import { SqlClient } from "effect/sql";
import { WorkspaceId } from "../src/author/workspace-contracts.js";
import {
  readAuthorSyncState,
  readAuthorInventory,
  withAuthorStateTransaction,
  saveAuthorSyncState,
} from "../src/author/state-store.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
} from "../src/library/store/database.js";
import { skitLayer } from "../src/platform/layer.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import { withLock } from "../src/platform/home-lock.js";

it.effect("Author checkpoint and Machine Settings writes commit and roll back together", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-shared-transaction-" });
    yield* prepareLibraryDatabase(home, true);
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
  "an unrecognized native inventory category is reported rather than silently omitted",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-corrupt-category-" });
      const workspace = WorkspaceId.make(`workspace_${"a".repeat(32)}`);
      yield* prepareLibraryDatabase(home, true);
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

it.effect("unknown Author checkpoint fields are refused", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-excess-" });
    const key = { workspaceId: WorkspaceId.make("workspace_" + "a".repeat(32)), locator: "one" };
    const unknown = { ...Sync.Idle.make({ base: null }), future: { kept: [null, false] } };
    const written = yield* Effect.result(
      withAuthorStateTransaction(home, saveAuthorSyncState(home, key, unknown)),
    );
    assert.strictEqual(written._tag, "Failure");
    assert.deepStrictEqual(yield* readAuthorSyncState(home, key), Sync.Idle.make({ base: null }));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
