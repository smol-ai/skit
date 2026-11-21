import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { database013 } from "./helpers/library-database-013.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
} from "../src/library/store/database.js";
import { saveLibrary } from "./helpers/library-store.js";
import { loadLibrary, writeLibrary, LibraryWriter } from "../src/library/store/library-store.js";
import { readCatalogue } from "../src/library/store/catalogue.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { AuthorHistory } from "../src/author/history.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import * as Sync from "../src/sync/sync.js";

const owner = (home: string) =>
  AuthorHistory.layer({ home }).pipe(Layer.provideMerge(AuthorWorkspace.layer));
const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-schema-014-" });
  const { state } = yield* fixture;
  const ancestry = state.sync_ancestry!;
  yield* saveLibrary(home, {
    ...state,
    sync_ancestry: {
      ...ancestry,
      base_manifest: {
        ...ancestry.base_manifest,
        snapshot_digests: [...ancestry.base_manifest.snapshot_digests].reverse(),
      },
    },
  });
  yield* fs.writeFileString(
    join(home, "machine.json"),
    JSON.stringify({
      schemaVersion: 5,
      machineId: makeMachineId(),
      legacyMachineId: { knownJson: [null, false, 1] },
      displayName: "Fixture",
      discoveryRoots: ["/b", "/a", "/b"],
      repositories: [
        { path: "/same", status: "watched" },
        { path: "/same", status: "ignored" },
      ],
      repositoryDecisionsInitialized: true,
    }),
  );
  const machine = yield* MachineSettings.read(home);
  const rootPath = join(home, "workspace");
  yield* fs.makeDirectory(rootPath);
  yield* fs.writeFileString(join(rootPath, "notes.txt"), "verbatim\n");
  const saved = yield* Effect.gen(function* () {
    const history = yield* AuthorHistory;
    const workspaces = yield* AuthorWorkspace;
    const root = yield* workspaces.resolveRoot(rootPath);
    const lease = yield* workspaces.acquire(root);
    const { workspaceId } = yield* lease.register(Option.none());
    const key = { workspaceId, locator: "skit://registry.example/proof/tools" };
    const revision = yield* history.refresh(root);
    const tree = yield* history.engineStore.tree(revision.treeHash);
    const state = Sync.Sending.make({ base: revision.id, revision: revision.id });
    yield* history.syncState.save(lease, key, { from: Sync.Idle.make({ base: null }), to: state });
    yield* history.backupState.save(lease, key, { from: null, to: revision.id });
    const writing = Sync.Writing.make({
      base: revision.id,
      from: revision.treeHash,
      to: revision.treeHash,
      next: state,
      merged: false,
    });
    yield* history.syncState.prepareWrite(lease, key, { from: state, to: writing });
    yield* history.inventory.refresh(lease, workspaceId, tree);
    return { key, revision, tree, state: writing };
  }).pipe(Effect.provide(owner(home)), Effect.scoped);
  return { fs, home, machine, saved, path: libraryDatabasePath(home) };
});
const snapshot = (path: string) =>
  withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schema = yield* sql<{
        name: string;
        sql: string | null;
      }>`SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name`;
      const rows = yield* Effect.forEach(schema, (table) =>
        Effect.gen(function* () {
          return [table.name, yield* sql`SELECT * FROM ${sql(table.name)} ORDER BY rowid`];
        }),
      );
      return { schema, rows };
    }),
    true,
  );

it.effect(
  "014 replaces modelled residue and cold owners export the exact known data with no live extra columns",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const before = yield* loadLibrary(f.home);
      const audit = yield* readLibraryAudit(f.home);
      yield* database013(f.home);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            (yield* sql<{ extra: string }>`SELECT extra FROM library_imports`).map((row) =>
              JSON.parse(row.extra),
            ),
            before.imports.map(() => ({ input: {} })),
          );
          assert.deepStrictEqual(
            JSON.parse((yield* sql<{ extra: string }>`SELECT extra FROM library_device`)[0]!.extra)
              .schemaVersion,
            before.schemaVersion,
          );
        }),
        true,
      );
      yield* prepareLibraryDatabase(f.home);
      assert.deepStrictEqual(yield* loadLibrary(f.home), before);
      assert.deepStrictEqual(yield* readLibraryAudit(f.home), audit);
      assert.deepStrictEqual(yield* MachineSettings.read(f.home), f.machine);
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        assert.deepStrictEqual(
          yield* history.engineStore.revision(f.saved.revision.id),
          f.saved.revision.revision,
        );
        assert.deepStrictEqual(
          yield* history.engineStore.tree(f.saved.revision.treeHash),
          f.saved.tree,
        );
        assert.deepStrictEqual(yield* history.syncState.read(f.saved.key), f.saved.state);
        assert.strictEqual(yield* history.backupState.read(f.saved.key), f.saved.revision.id);
      }).pipe(Effect.provide(owner(f.home)));
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const { name } of yield* sql<{
            name: string;
          }>`SELECT name FROM sqlite_master WHERE type='table'`) {
            const columns = yield* sql<{ name: string }>`PRAGMA table_info(${sql(name)})`;
            assert.deepStrictEqual(
              columns.filter((column) => column.name === "extra" || column.name.endsWith("_extra")),
              [],
              name,
            );
          }
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
          assert.deepStrictEqual(
            (yield* sql<{ name: string }>`PRAGMA table_info(author_history_legacy_documents)`).map(
              (row) => row.name,
            ),
            ["kind", "hash", "document", "source_rows"],
          );
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const [table, column, key] of [
  ["library_collections", "extra", "future"],
  ["library_device", "extra", "future"],
  ["library_imports", "extra", "future"],
  ["library_sync", "extra", "future"],
  ["author_revisions", "extra", "future"],
  ["author_revisions", "author_extra", "future"],
  ["author_tree_entries", "extra", "future"],
  ["author_trees", "extra", "future"],
  ["author_sync_checkpoints", "extra", "future"],
  ["author_sync_checkpoints", "next_extra", "future"],
  ["author_inventories", "extra", "future"],
  ["author_inventories", "inventory_extra", "future"],
  ["machine", "extra", "future"],
  ["library_device", "extra", "device_skill_selection.invocation_policies.future"],
  ["library_sync", "extra", "base_manifest.future"],
] satisfies ReadonlyArray<readonly [string, string, string]>)
  it.effect(
    `014 refuses an unknown field in ${table}.${column}.${key} with schema and every row unchanged`,
    () =>
      Effect.gen(function* () {
        const f = yield* prepared;
        yield* database013(f.home);
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE ${sql(table)} SET ${sql(column)}=json_set(COALESCE(${sql(column)},'{}'),${"$." + key},json('{"kept":[null,false]}'))`;
          }),
        );
        const before = yield* snapshot(f.path);
        const result = yield* Effect.result(prepareLibraryDatabase(f.home));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          const failure = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              cause: Schema.Struct({
                cause: Schema.Struct({ reason: Schema.Struct({ issue: Schema.String }) }),
              }),
            }),
          )(result.failure);
          assert.isTrue(failure.cause.cause.reason.issue.includes(`${table}.${key}`));
        }
        assert.deepStrictEqual(yield* snapshot(f.path), before);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "known wrong types and excess write properties fail typed without changing rows, revision or audit",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const before = yield* readCatalogue(f.home);
      const audit = yield* readLibraryAudit(f.home);
      for (const [key, value] of [
        ["label", 123],
        ["future", { kept: true }],
      ] satisfies ReadonlyArray<readonly [string, unknown]>) {
        const next = structuredClone(before.value);
        Object.defineProperty(next.collections[0]!, key, {
          value,
          enumerable: true,
          configurable: true,
        });
        yield* writeLibrary(
          f.home,
          Effect.gen(function* () {
            const writer = yield* LibraryWriter;
            const revision = yield* writer.revision;
            const result = yield* Effect.result(writer.saveCatalogue(next, before.value, revision));
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.strictEqual(result.failure._tag, "InvalidLibraryState");
            assert.strictEqual(yield* writer.revision, revision);
          }),
        );
        assert.deepStrictEqual(yield* readCatalogue(f.home), before);
        assert.deepStrictEqual(yield* readLibraryAudit(f.home), audit);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "an excess property in a declared JSON column fails on read instead of being stripped",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient)`UPDATE library_imports SET source_identity=json_set(source_identity,'$.future',true)`;
        }),
      );
      const before = yield* snapshot(f.path);
      const result = yield* Effect.result(readCatalogue(f.home));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidLibraryState");
      assert.deepStrictEqual(yield* snapshot(f.path), before);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
