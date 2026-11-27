import { saveLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { skitLayer } from "../src/platform/layer.js";
import { AuthorHistory } from "../src/author/internal/history.js";
import { AuthorWorkspace } from "../src/author/internal/workspace.js";
import { lockFile } from "../src/platform/file-lock.js";
import * as History from "../src/history/history.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
} from "../src/library/database.js";
import { knownHistoryRows } from "../src/author/internal/history-rows.js";
import { Hash } from "../src/shared/hash.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import { loadLibrary } from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import { canonicalJson } from "../src/shared/json.js";

const owner = (home: string) =>
  AuthorHistory.layer({ home }).pipe(Layer.provideMerge(AuthorWorkspace.layer));

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-metadata-" });
  const tree: History.Tree = [
    { kind: "directory", path: "duplicate" },
    { kind: "file", path: "duplicate", mode: 0o755, bytes: new Uint8Array([0, 128, 255]) },
    { kind: "file", path: "duplicate", mode: 0o644, bytes: new Uint8Array([0, 128, 255]) },
    { kind: "symlink", path: "pointer", target: "duplicate" },
  ];
  const hash = yield* History.treeHash(tree);
  const missing = History.RevisionId.make("sha256:" + "d".repeat(64));
  const revision: History.Revision = {
    tree: hash,
    parents: [missing, missing],
    edits: Object.fromEntries(tree.map((entry) => [entry.path.normalize("NFC"), -100])),
    author: { device: makeMachineId(), at: -100 },
  };
  const store = (yield* AuthorHistory.pipe(Effect.provide(owner(home)))).engineStore;
  yield* store.putTree(tree);
  const id = yield* store.commit(revision);
  return { fs, home, tree, hash, revision, id, path: libraryDatabasePath(home) };
});

it.effect("a stored directory cannot hide invalid file-only columns", () =>
  Effect.gen(function* () {
    const f = yield* prepared;
    const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    yield* store.tree(f.hash);
    yield* withLibraryDatabase(
      f.path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA ignore_check_constraints=ON`;
        yield* sql`UPDATE author_tree_entries SET mode=420 WHERE kind='directory'`;
        yield* sql`PRAGMA ignore_check_constraints=OFF`;
      }),
    );
    assert.strictEqual((yield* Effect.flip(store.tree(f.hash)))._tag, "History.StoreCorrupt");
    assert.strictEqual((yield* Effect.flip(store.putTree(f.tree)))._tag, "History.StoreCorrupt");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a damaged ordered parent list fails validation and a repeated commit cannot repair it",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      yield* store.revision(f.id);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM author_revision_parents WHERE position=0`;
        }),
      );
      assert.strictEqual((yield* Effect.flip(store.revision(f.id)))._tag, "History.StoreCorrupt");
      assert.strictEqual(
        (yield* Effect.flip(store.commit(f.revision)))._tag,
        "History.StoreCorrupt",
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed scan keeps native recovery evidence without the shared writer and imports it without a timeline",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-recovery-" });
      const database = libraryDatabasePath(home);
      const directory = join(home, "history");
      const root = join(home, "source");
      yield* fs.makeDirectory(root);
      const bytes = new TextEncoder().encode("kept without a device identity");
      yield* fs.writeFile(join(root, "notes.txt"), bytes);
      yield* fs.chmod(join(root, "notes.txt"), 0o644);
      const expected: History.Tree = [{ kind: "file", path: "notes.txt", mode: 0o644, bytes }];
      const hash = yield* History.treeHash(expected);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(home, "lock.sqlite"));
          const failure = yield* Effect.gen(function* () {
            const history = yield* AuthorHistory;
            const workspace = yield* AuthorWorkspace;
            return yield* Effect.flip(history.refresh(yield* workspace.resolveRoot(root)));
          }).pipe(Effect.provide(owner(home)));
          assert.strictEqual(failure._tag, "HomeBusy");
          assert.isFalse(yield* fs.exists(database));
        }),
      );
      const files = yield* fs.readDirectory(join(directory, "recovery", "trees"));
      assert.deepStrictEqual(files, [`${hash.slice(7)}.json`]);
      const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(home)),
      );
      assert.deepStrictEqual(yield* cold.tree(hash), expected);
      yield* withLibraryDatabase(
        database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_events`, []);
        }),
        true,
      );
      assert.deepStrictEqual(yield* fs.readDirectory(join(directory, "recovery", "trees")), files);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(home, "lock.sqlite"));
          const reader = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
            Effect.provide(owner(home)),
          );
          assert.deepStrictEqual(yield* reader.tree(hash), expected);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a quiescent home copy restores Library rows and native Author revision bytes", () =>
  Effect.gen(function* () {
    const f = yield* prepared;
    const state = emptyLibraryState();
    yield* saveLibrary(f.home, state);
    yield* migrateLocalLibraryState(f.home);
    yield* MachineSettings.updateDiscovery(f.home, { discoveryRoots: ["/keep"] });

    const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    assert.deepStrictEqual(yield* store.tree(f.hash), f.tree);
    assert.deepStrictEqual(yield* store.revision(f.id), f.revision);

    const backup = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-backup-" });
    yield* f.fs.copy(f.home, join(backup, "backup"));
    yield* f.fs.remove(f.home, { recursive: true });
    const restored = join(backup, "restored");
    yield* f.fs.copy(join(backup, "backup"), restored);

    assert.strictEqual(canonicalJson(yield* loadLibrary(restored)), canonicalJson(state));
    assert.deepStrictEqual((yield* MachineSettings.read(restored)).discoveryRoots, ["/keep"]);
    const restoredStore = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(restored)),
    );
    assert.deepStrictEqual(yield* restoredStore.revision(f.id), f.revision);
    assert.deepStrictEqual(yield* restoredStore.tree(f.hash), f.tree);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("metadata existence batches distinguish tree and revision identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-history-batch-" });
    yield* prepareLibraryDatabase(home, true);
    const hashes = Array.from({ length: 502 }, (_, i) =>
      Hash.make("sha256:" + (i + 1).toString(16).padStart(64, "0")),
    );
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const [first, ...rest] = hashes.slice(0, 501).map((hash) => ({ hash }));
            if (first) yield* sql`INSERT INTO author_trees ${sql.insert([first, ...rest])}`;
            yield* sql`INSERT INTO author_revisions VALUES(${hashes[501]!},${hashes[500]!},'device',0,'{}')`;
          }),
        );
        const trees = yield* knownHistoryRows("tree", [...hashes, hashes[0]!]);
        const revisions = yield* knownHistoryRows("revision", hashes);
        assert.deepStrictEqual([...trees].sort(), hashes.slice(0, 501).sort());
        assert.deepStrictEqual([...revisions], [hashes[501]!]);
        assert.strictEqual((yield* knownHistoryRows("tree", [])).size, 0);
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("stored Author rows keep duplicate paths and declared metadata after a cold reopen", () =>
  Effect.gen(function* () {
    const f = yield* prepared;
    const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    assert.deepStrictEqual(yield* store.tree(f.hash), f.tree);
    assert.deepStrictEqual(yield* store.revision(f.id), f.revision);
    const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    assert.deepStrictEqual(yield* cold.revision(f.id), f.revision);
    assert.deepStrictEqual(yield* cold.tree(f.hash), f.tree);
    assert.deepStrictEqual(yield* cold.trees, [f.hash]);
    yield* withLibraryDatabase(
      f.path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        const row = (yield* sql<{
          edits_json: string;
        }>`SELECT * FROM author_revisions WHERE hash=${f.id}`)[0]!;
        assert.deepStrictEqual(JSON.parse(row.edits_json), f.revision.edits);
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
