import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { skitLayer } from "../src/platform/layer.js";
import { AuthorHistory } from "../src/author/history.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import { lockFile } from "../src/platform/file-lock.js";
import * as History from "../src/history/history.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import {
  libraryDatabasePath,
  prepareLibraryDatabase,
  withLibraryDatabase,
} from "../src/library/store/database.js";
import { knownHistoryRows } from "../src/author/history-rows.js";
import { Hash } from "../src/shared/hash.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import { loadLibrary } from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import * as MachineSettings from "../src/library/machine-settings.js";
import { canonicalJson, JsonObject } from "../src/shared/json.js";

const owner = (home: string) =>
  AuthorHistory.layer({ home }).pipe(Layer.provideMerge(AuthorWorkspace.layer));

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-metadata-" });
  const directory = join(home, "history");
  yield* fs.makeDirectory(join(directory, "trees"), { recursive: true });
  yield* fs.makeDirectory(join(directory, "revisions"));
  const tree: History.Tree = [
    { kind: "directory", path: "duplicate" },
    { kind: "file", path: "duplicate", mode: 0o755, bytes: new Uint8Array([0, 128, 255]) },
    { kind: "file", path: "duplicate", mode: 0o644, bytes: new Uint8Array([0, 128, 255]) },
    { kind: "symlink", path: "pointer", target: "duplicate" },
  ];
  const hash = yield* History.treeHash(tree);
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(History.Tree)),
  )(tree);
  const entries = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(JsonObject)),
  )(encoded);
  const raw = entries.map((entry, index) => ({
    ...entry,
    extension: { index, ordered: [null, false, false] },
    ...(index === 0
      ? { mode: { unknown: true }, blob: null }
      : index === 1
        ? { blob: { legacyUnknown: true } }
        : {}),
  }));
  const source = JSON.stringify(raw, null, 2) + "\n";
  yield* fs.writeFileString(join(directory, "trees", `${hash.slice(7)}.json`), source);
  const missing = History.RevisionId.make("sha256:" + "d".repeat(64));
  const revision: History.Revision = {
    tree: hash,
    parents: [missing, missing],
    author: { device: makeMachineId(), at: -100 },
  };
  const id = yield* History.revisionId(revision);
  const revisionRaw = {
    ...revision,
    extension: { kept: null },
    author: { ...revision.author, extension: { clock: "backwards" } },
  };
  const revisionSource = JSON.stringify(revisionRaw, null, 2) + "\n";
  yield* fs.writeFileString(join(directory, "revisions", `${id.slice(7)}.json`), revisionSource);
  return {
    fs,
    home,
    directory,
    tree,
    hash,
    source,
    raw,
    revision,
    id,
    revisionSource,
    path: libraryDatabasePath(home),
  };
});

it.effect("manifest header extensions stay native after the original document changes", () =>
  Effect.gen(function* () {
    const f = yield* prepared;
    const hash = yield* History.treeHash([]);
    const file = join(f.directory, "trees", `${hash.slice(7)}.json`);
    yield* f.fs.writeFileString(
      file,
      JSON.stringify({
        schema: "skit.author-tree.v1",
        entries: [],
        extension: { empty: [], kept: null },
      }),
    );
    const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    assert.deepStrictEqual(yield* store.tree(hash), []);
    yield* withLibraryDatabase(
      f.path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT extra FROM author_trees WHERE hash=${hash}`, [
          { extra: JSON.stringify({ extension: { empty: [], kept: null } }) },
        ]);
      }),
      true,
    );
    yield* f.fs.writeFileString(file, "changed backup evidence");
    const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    assert.deepStrictEqual(yield* cold.tree(hash), []);
    assert.strictEqual(yield* f.fs.readFileString(file), "changed backup evidence");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

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
  "metadata migration keeps duplicate paths, parent order, shallow ancestry and every extension",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      assert.deepStrictEqual(yield* store.tree(f.hash), f.tree);
      assert.deepStrictEqual(yield* store.revision(f.id), f.revision);
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.directory, "trees", `${f.hash.slice(7)}.json`)),
        f.source,
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.directory, "revisions", `${f.id.slice(7)}.json`)),
        f.revisionSource,
      );
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            extra: string;
          }>`SELECT extra FROM author_tree_entries ORDER BY position`;
          const extras = yield* Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(row.extra),
          );
          assert.deepStrictEqual(extras[0], {
            extension: f.raw[0]!.extension,
            mode: { unknown: true },
            blob: null,
          });
          assert.deepStrictEqual(extras[1], {
            extension: f.raw[1]!.extension,
            blob: { legacyUnknown: true },
          });
          const parents = yield* sql<{
            parent_hash: string;
          }>`SELECT parent_hash FROM author_revision_parents ORDER BY position`;
          assert.deepStrictEqual(
            parents.map((row) => row.parent_hash),
            [...f.revision.parents],
          );
          const revision = (yield* sql<{
            extra: string;
            author_extra: string;
          }>`SELECT extra,author_extra FROM author_revisions`)[0]!;
          assert.strictEqual(revision.extra, JSON.stringify({ extension: { kept: null } }));
          assert.strictEqual(
            revision.author_extra,
            JSON.stringify({ extension: { clock: "backwards" } }),
          );
        }),
        true,
      );
      yield* f.fs.rename(join(f.directory, "trees"), join(f.directory, "trees.backup"));
      yield* f.fs.rename(join(f.directory, "revisions"), join(f.directory, "revisions.backup"));
      const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      assert.deepStrictEqual(yield* cold.tree(f.hash), f.tree);
      assert.deepStrictEqual(yield* cold.revision(f.id), f.revision);
      assert.deepStrictEqual(yield* cold.trees, [f.hash]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "an unreadable legacy document is kept exactly and does not block an unrelated tree",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      const badTree: History.Tree = [];
      const bad = yield* History.treeHash(badTree);
      const text = " [ invalid legacy evidence \n";
      yield* f.fs.writeFileString(join(f.directory, "trees", `${bad.slice(7)}.json`), text);
      const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      assert.deepStrictEqual(yield* store.tree(f.hash), f.tree);
      assert.strictEqual((yield* Effect.flip(store.tree(bad)))._tag, "History.StoreCorrupt");
      assert.strictEqual((yield* Effect.flip(store.putTree(badTree)))._tag, "History.StoreCorrupt");
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT document FROM author_history_legacy_documents`, [
            { document: text },
          ]);
        }),
        true,
      );
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.directory, "trees", `${bad.slice(7)}.json`)),
        text,
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "legacy import rollback leaves no partial metadata or completion marker and retries losslessly",
  () =>
    Effect.gen(function* () {
      const f = yield* prepared;
      yield* prepareLibraryDatabase(f.home, true);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_parent BEFORE INSERT ON author_revision_parents WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'refused'); END`;
        }),
      );
      const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      assert.strictEqual((yield* Effect.flip(store.tree(f.hash)))._tag, "History.StoreFailed");
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_trees`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_tree_entries`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_revisions`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_revision_parents`, []);
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_metadata_import`, []);
          yield* sql`DROP TRIGGER refuse_parent`;
        }),
      );
      const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      assert.deepStrictEqual(yield* cold.tree(f.hash), f.tree);
      assert.deepStrictEqual(yield* cold.revision(f.id), f.revision);
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
      const f = yield* prepared;
      yield* f.fs.remove(join(f.directory, "trees"), { recursive: true });
      yield* f.fs.remove(join(f.directory, "revisions"), { recursive: true });
      const root = join(f.home, "source");
      yield* f.fs.makeDirectory(root);
      const bytes = new TextEncoder().encode("kept without a device identity");
      yield* f.fs.writeFile(join(root, "notes.txt"), bytes);
      yield* f.fs.chmod(join(root, "notes.txt"), 0o644);
      const expected: History.Tree = [{ kind: "file", path: "notes.txt", mode: 0o644, bytes }];
      const hash = yield* History.treeHash(expected);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(f.home, "lock.sqlite"));
          const failure = yield* Effect.gen(function* () {
            const history = yield* AuthorHistory;
            const workspace = yield* AuthorWorkspace;
            return yield* Effect.flip(history.refresh(yield* workspace.resolveRoot(root)));
          }).pipe(Effect.provide(owner(f.home)));
          assert.strictEqual(failure._tag, "HomeBusy");
          assert.isFalse(yield* f.fs.exists(f.path));
        }),
      );
      const files = yield* f.fs.readDirectory(join(f.directory, "recovery", "trees"));
      assert.deepStrictEqual(files, [`${hash.slice(7)}.json`]);
      const cold = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(owner(f.home)),
      );
      assert.deepStrictEqual(yield* cold.tree(hash), expected);
      yield* withLibraryDatabase(
        f.path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT * FROM author_history_events`, []);
        }),
        true,
      );
      assert.deepStrictEqual(
        yield* f.fs.readDirectory(join(f.directory, "recovery", "trees")),
        files,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(f.home, "lock.sqlite"));
          const reader = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
            Effect.provide(owner(f.home)),
          );
          assert.deepStrictEqual(yield* reader.tree(hash), expected);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a quiescent home copy restores Library rows and native Author revision bytes", () =>
  Effect.gen(function* () {
    const f = yield* prepared;
    const state = { ...emptyLibraryState(), extension: { keep: [null, {}, []] } };
    yield* f.fs.writeFileString(join(f.home, "state.json"), JSON.stringify(state));
    yield* migrateLocalLibraryState(f.home);
    yield* MachineSettings.updateDiscovery(f.home, { discoveryRoots: ["/keep"] });

    const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
      Effect.provide(owner(f.home)),
    );
    assert.deepStrictEqual(yield* store.tree(f.hash), f.tree);
    assert.deepStrictEqual(yield* store.revision(f.id), f.revision);
    yield* f.fs.remove(join(f.directory, "trees"), { recursive: true });
    yield* f.fs.remove(join(f.directory, "revisions"), { recursive: true });

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

it.effect(
  "metadata existence batches distinguish tree, revision and unreadable legacy identities",
  () =>
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
              const [first, ...rest] = hashes.slice(0, 500).map((hash) => ({ hash, extra: "{}" }));
              if (first) yield* sql`INSERT INTO author_trees ${sql.insert([first, ...rest])}`;
              yield* sql`INSERT INTO author_history_legacy_documents(kind,hash,document) VALUES('tree',${hashes[500]!},'unreadable'),('revision',${hashes[501]!},'unreadable')`;
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
