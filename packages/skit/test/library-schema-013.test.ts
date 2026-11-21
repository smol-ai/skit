import { saveLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { database012, migration013 } from "./helpers/library-database-012.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
} from "../src/library/store/database.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { loadLibrary } from "../src/library/store/library-store.js";
import { LibraryAuditEvent, readLibraryAudit } from "../src/library/audit/audit-log.js";
import { makeOperationId, makeMachineId } from "../src/library/entity-ids.js";
import { AuthorHistory } from "../src/author/history.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import * as History from "../src/history/history.js";
import * as Sync from "../src/sync/sync.js";
import * as MachineSettings from "../src/library/machine-settings.js";

const owner = (home: string) =>
  AuthorHistory.layer({ home }).pipe(Layer.provideMerge(AuthorWorkspace.layer));
const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-schema-013-" });
  const { state } = yield* fixture;
  const events = yield* Effect.forEach([1, 0], (day) =>
    LibraryAuditEvent.makeEffect({
      schemaVersion: 1,
      eventId: makeOperationId(),
      occurredAt: `2026-11-0${day + 1}T00:00:00.000Z`,
      type: "library.imported",
      workflow: "fixture",
      changes: [],
    }),
  );
  yield* fs.writeFileString(
    join(home, "audit.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  yield* migrateLocalLibraryState(home);
  yield* saveLibrary(home, state);
  return { fs, home, state, path: libraryDatabasePath(home) };
});
const unchangedRows = (path: string) =>
  withLibraryDatabase(
    path,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('author_revisions','effect_sql_migrations') ORDER BY name`;
      return yield* Effect.forEach(tables, (table) =>
        Effect.gen(function* () {
          return [
            table.name,
            yield* table.name === "author_history_legacy_documents"
              ? sql`SELECT kind,hash,document FROM author_history_legacy_documents ORDER BY rowid`
              : sql`SELECT * FROM ${sql(table.name)} ORDER BY rowid`,
          ];
        }),
      );
    }),
    true,
  );

it.effect(
  "012 upgrades losslessly, then cold owners export the exact state, audit, checkpoints and history",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const rootPath = join(f.home, "workspace");
      yield* f.fs.makeDirectory(rootPath);
      yield* f.fs.writeFileString(join(rootPath, "notes.txt"), "exact bytes\n");
      const saved = yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const workspaces = yield* AuthorWorkspace;
        const root = yield* workspaces.resolveRoot(rootPath);
        const lease = yield* workspaces.acquire(root);
        const { workspaceId } = yield* lease.register(Option.none());
        const key = { workspaceId, locator: "skit://registry.example/proof/tools" };
        const revision = yield* history.refresh(root);
        const state = Sync.Sending.make({ base: revision.id, revision: revision.id });
        yield* history.syncState.save(lease, key, {
          from: Sync.Idle.make({ base: null }),
          to: state,
        });
        yield* history.backupState.save(lease, key, { from: null, to: revision.id });
        return { key, revision, tree: yield* history.engineStore.tree(revision.treeHash), state };
      }).pipe(Effect.provide(owner(f.home)), Effect.scoped);
      const before = yield* loadLibrary(f.home);
      const audit = yield* readLibraryAudit(f.home);
      const machine = yield* MachineSettings.read(f.home);
      yield* database012(f.home);
      // Negative/fraction-free path times are independent of author_at.
      const edits = { "notes.txt": -123456789, "": 0 };
      const revision = { ...saved.revision.revision, edits };
      const id = yield* History.revisionId(revision);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,extra,author_extra)
        VALUES(${id},${revision.tree},${revision.author.device},${revision.author.at},${JSON.stringify({ edits })},${"{}"})`;
        }),
      );
      const rows = yield* unchangedRows(f.path);
      yield* migration013(f.home);
      assert.deepStrictEqual(yield* unchangedRows(f.path), rows);
      yield* prepareLibraryDatabase(f.home);
      assert.deepStrictEqual(yield* loadLibrary(f.home), before);
      assert.deepStrictEqual(yield* readLibraryAudit(f.home), audit);
      assert.deepStrictEqual(yield* MachineSettings.read(f.home), machine);
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        assert.deepStrictEqual(yield* history.engineStore.revision(id), revision);
        assert.deepStrictEqual(
          yield* history.engineStore.tree(saved.revision.treeHash),
          saved.tree,
        );
        assert.deepStrictEqual(yield* history.syncState.read(saved.key), saved.state);
        assert.strictEqual(yield* history.backupState.read(saved.key), saved.revision.id);
      }).pipe(Effect.provide(owner(f.home)));
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const row = (yield* sql<{
            edits_json: string;
          }>`SELECT edits_json FROM author_revisions WHERE hash=${id}`)[0]!;
          assert.deepStrictEqual(JSON.parse(row.edits_json), edits);
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const failure of ["installed-owner", "edits"] as const)
  it.effect(`013 refuses ${failure} without changing source rows, schema or ledger`, () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* database012(f.home);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (failure === "installed-owner")
            yield* sql`UPDATE library_installed_skills SET skill_version_id=${f.state.skills[1]!.versions[0]!.skill_version_id} WHERE installed_skill_id=${f.state.installed_skills[0]!.installed_skill_id}`;
          if (failure === "edits") {
            const hash = "sha256:" + "a".repeat(64);
            yield* sql`INSERT INTO author_trees(hash,extra) VALUES(${hash},'{}')`;
            yield* sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,extra,author_extra) VALUES(${hash},${hash},'device',1,${'{"edits":null,"unknown":[1,1]}'},'{}')`;
          }
        }),
      );
      const before = yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          return yield* (yield* SqlClient.SqlClient)`SELECT * FROM author_revisions`;
        }),
        true,
      );
      const rows = yield* unchangedRows(f.path);
      const result = yield* Effect.result(prepareLibraryDatabase(f.home));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "LibrarySqlError");
      assert.deepStrictEqual(yield* unchangedRows(f.path), rows);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_revisions`, before);
          assert.deepStrictEqual(
            yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id=13`,
            [],
          );
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM sqlite_master WHERE name LIKE '%_next' OR name='library_skill_version_owners'`,
            [],
          );
        }),
        true,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "direct SQL keeps historical consent references, rejects wrong ownership and missing trees, and defers imports",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const before = yield* sql`SELECT * FROM library_installed_skills ORDER BY rowid`;
          assert.strictEqual(
            (yield* Effect.result(
              sql`UPDATE library_installed_skills SET skill_version_id=${f.state.skills[1]!.versions[0]!.skill_version_id} WHERE installed_skill_id=${f.state.installed_skills[0]!.installed_skill_id}`,
            ))._tag,
            "Failure",
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM library_installed_skills ORDER BY rowid`,
            before,
          );
          yield* sql`UPDATE library_assessment_acceptances SET skill_version_id='absent'`;
          assert.deepStrictEqual(
            yield* sql`SELECT DISTINCT skill_version_id FROM library_assessment_acceptances`,
            [{ skill_version_id: "absent" }],
          );
          for (const reverse of [false, true]) {
            const hash = "sha256:" + (reverse ? "b" : "c").repeat(64);
            const revision = sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,edits_json) VALUES(${hash},${hash},'device',-1,'{}')`;
            assert.strictEqual((yield* Effect.result(revision))._tag, "Failure");
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const tree = sql`INSERT INTO author_trees(hash) VALUES(${hash})`;
                if (reverse) {
                  yield* revision;
                  yield* tree;
                } else {
                  yield* tree;
                  yield* revision;
                }
              }),
            );
          }
          assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const unknown of [false, true])
  it.effect(
    `013 converts native 012 revision-only rows, preserving evidence (excess=${unknown})`,
    () =>
      Effect.gen(function* () {
        const f = yield* prepared;
        const before = yield* loadLibrary(f.home);
        yield* database012(f.home);
        const tree = History.TreeHash.make("sha256:" + "d".repeat(64));
        const parent = History.RevisionId.make("sha256:" + "b".repeat(64));
        const revision: History.Revision = {
          tree,
          parents: [parent, parent],
          author: { device: makeMachineId(), at: -100 },
          edits: { a: -200, "": 0 },
        };
        const id = yield* History.revisionId(revision);
        const extra = unknown
          ? ' { "edits": { "a": -200, "": 0 }, "future": [null, false, false] } '
          : ' { "edits": { "a": -200, "": 0 } } ';
        const authorExtra = unknown ? ' { "unknown": { "ordered": [2, 1] } } ' : " {} ";
        const raw = {
          hash: id,
          tree_hash: tree,
          author_device: revision.author.device,
          author_at: -100,
          extra,
          author_extra: authorExtra,
        };
        const parents = [0, 1].map((position) => ({
          revision_hash: id,
          position,
          parent_hash: parent,
        }));
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // The pre-013 loader commits its receipt in the same transaction as these rows.
            yield* sql`INSERT INTO author_metadata_import(id,source_hash) VALUES(1,${"sha256:" + "f".repeat(64)})`;
            yield* sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,extra,author_extra)
        VALUES(${id},${tree},${raw.author_device},${raw.author_at},${extra},${authorExtra})`;
            for (const row of parents)
              yield* sql`INSERT INTO author_revision_parents(revision_hash,position,parent_hash) VALUES(${id},${row.position},${parent})`;
          }),
        );
        const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
          Effect.provide(owner(f.home)),
        );
        if (unknown)
          assert.strictEqual((yield* Effect.flip(cold.revision(id)))._tag, "History.StoreCorrupt");
        else assert.deepStrictEqual(yield* cold.revision(id), revision);
        assert.deepStrictEqual(yield* cold.trees, []);
        assert.deepStrictEqual(yield* loadLibrary(f.home), before);
        yield* withLibraryDatabase(
          f.path,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* sql`SELECT * FROM author_revisions WHERE hash=${id}`, []);
            assert.deepStrictEqual(
              yield* sql`SELECT * FROM author_revision_parents WHERE revision_hash=${id}`,
              [],
            );
            const row = (yield* sql<{
              document: string;
              source_rows: string;
            }>`SELECT document,source_rows FROM author_history_legacy_documents WHERE hash=${id}`)[0]!;
            assert.deepStrictEqual(JSON.parse(row.source_rows), { revision: raw, parents });
            assert.deepStrictEqual(JSON.parse(row.document), {
              ...revision,
              ...(unknown ? { future: [null, false, false] } : {}),
              author: { ...revision.author, ...(unknown ? { unknown: { ordered: [2, 1] } } : {}) },
            });
            assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
            assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
          }),
          true,
        );
        const reopened = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
          Effect.provide(owner(f.home)),
        );
        if (unknown)
          assert.strictEqual(
            (yield* Effect.flip(reopened.revision(id)))._tag,
            "History.StoreCorrupt",
          );
        else assert.deepStrictEqual(yield* reopened.revision(id), revision);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
