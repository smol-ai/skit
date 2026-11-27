import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { systemError } from "effect/PlatformError";
import { dirname, join } from "node:path";
import * as History from "../src/history/history.js";
import { AuthorHistory } from "../src/author/internal/history.js";
import { AuthorWorkspace } from "../src/author/internal/workspace.js";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";
import { SqlClient } from "effect/sql";
import { prepareLibraryDatabase, withLibraryDatabase } from "../src/library/database.js";

const openStore = (directory: string) =>
  Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
    Effect.provide(
      AuthorHistory.layer({ home: dirname(directory) }).pipe(Layer.provide(AuthorWorkspace.layer)),
    ),
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-store-" });
  const directory = join(root, "history");
  return {
    fs,
    directory,
    database: join(root, "library.sqlite"),
    blobs: join(root, "file-bytes"),
    trees: join(directory, "trees"),
  };
});
const file = (path: string, text: string): History.Tree[number] => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: new TextEncoder().encode(text),
});

it.effect("byte-store writer contention remains HomeBusy at the Author owner boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* lockFile(join(dirname(f.directory), "lock.sqlite"));
    const error = yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      return yield* Effect.flip(history.saveTree([file("notes.txt", "new bytes")]));
    }).pipe(
      Effect.provide(
        AuthorHistory.layer({ home: dirname(f.directory) }).pipe(
          Layer.provide(AuthorWorkspace.layer),
        ),
      ),
    );
    expect(error).toMatchObject({
      _tag: "HomeBusy",
      path: join(dirname(f.directory), "lock.sqlite"),
      code: "CONFLICT",
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "one small edit stores one new blob while preserving metadata and canonical identities",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const store = yield* openStore(f.directory);
      // Size does not affect deduplication; keep the fixture small for full-tree comparisons.
      const large = new Uint8Array(16 * 1024).fill(93);
      const first: History.Tree = [
        { path: "empty", kind: "directory" },
        { path: "large", kind: "file", mode: 0o755, bytes: large },
        { path: "same-bytes", kind: "file", mode: 0o644, bytes: large },
        { path: "pointer", kind: "symlink", target: "small" },
        file("small", "one"),
      ];
      const before = yield* store.putTree(first);
      expect(before).toBe(yield* History.treeHash(first));
      const blobsBefore = yield* f.fs.readDirectory(f.blobs);
      expect(blobsBefore).toHaveLength(2);
      const second = first.map((entry) => (entry.path === "small" ? file("small", "two!") : entry));
      const after = yield* store.putTree(second);
      expect(after).not.toBe(before);
      const names = yield* f.fs.readDirectory(f.blobs);
      expect(names).toHaveLength(3);
      const total = (yield* Effect.forEach(names, (name) => f.fs.stat(join(f.blobs, name)))).reduce(
        (sum, stat) => sum + Number(stat.size),
        0,
      );
      expect(total).toBe(large.length + 3 + 4);
      for (const id of [before, after])
        expect(yield* f.fs.exists(join(f.trees, `${id.slice(7)}.json`))).toBe(false);
      yield* withLibraryDatabase(
        f.database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect((yield* sql`SELECT hash FROM author_trees`).length).toBe(2);
          expect((yield* sql`SELECT path FROM author_tree_entries`).length).toBe(10);
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(author_tree_entries)`;
          expect(columns.some((row) => row.name === "bytes")).toBe(false);
        }),
        true,
      );
      expect(yield* store.tree(before)).toEqual(History.sortTree(first));
      expect(yield* store.tree(after)).toEqual(History.sortTree(second));
      const read = yield* store.tree(before);
      const bytes = read.find((entry) => entry.kind === "file" && entry.path === "large");
      if (bytes?.kind !== "file") return yield* Effect.die("Missing fixture file");
      bytes.bytes[0] = 0;
      expect(yield* store.tree(before)).toEqual(History.sortTree(first));
      for (const name of names)
        expect((yield* f.fs.stat(join(f.blobs, name))).mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["missing", "corrupt"] as const)(
  "refuses a %s blob on read and repeated save without repairing it",
  (damage) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const store = yield* openStore(f.directory);
      const tree = [file("notes.txt", "original")];
      const id = yield* store.putTree(tree);
      const [name] = yield* f.fs.readDirectory(f.blobs);
      if (name === undefined) return yield* Effect.die("Missing fixture blob");
      const blob = join(f.blobs, name);
      const metadata = yield* withLibraryDatabase(
        f.database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT * FROM author_tree_entries WHERE tree_hash=${id}`;
        }),
        true,
      );
      if (damage === "missing") yield* f.fs.remove(blob);
      else yield* f.fs.writeFileString(blob, "damaged");
      const cold = yield* openStore(f.directory);
      for (const read of [
        cold.tree(id).pipe(Effect.asVoid),
        cold.putTree(tree).pipe(Effect.asVoid),
      ])
        expect(yield* Effect.flip(read)).toMatchObject({
          _tag: "History.StoreCorrupt",
          kind: "tree",
          hash: id,
        });
      yield* withLibraryDatabase(
        f.database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT * FROM author_tree_entries WHERE tree_hash=${id}`).toEqual(
            metadata,
          );
        }),
        true,
      );
      if (damage === "missing") expect(yield* f.fs.exists(blob)).toBe(false);
      else expect(yield* f.fs.readFileString(blob)).toBe("damaged");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["blob"] as const)
  it.effect(`cold retry completes an interruption before ${boundary} publication`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const tree = [file("notes.txt", "saved after retry")];
      const id = yield* History.treeHash(tree);
      const manifest = join(f.trees, `${id.slice(7)}.json`);
      let stopped = false;
      let flushedBlobs = false;
      const files = FileSystem.FileSystem.of({
        ...f.fs,
        open: (path, options) =>
          f.fs.open(path, options).pipe(
            Effect.map((handle) =>
              path.startsWith(`${f.blobs}/`)
                ? new Proxy(handle, {
                    get(target, key) {
                      if (key === "sync")
                        return target.sync.pipe(
                          Effect.tap(() =>
                            Effect.sync(() => {
                              flushedBlobs = true;
                            }),
                          ),
                        );
                      const value = Reflect.get(target, key, target);
                      return typeof value === "function" ? value.bind(target) : value;
                    },
                  })
                : handle,
            ),
          ),
        link: (from, to) =>
          Effect.gen(function* () {
            if (to.startsWith(`${f.blobs}/`)) {
              stopped = true;
              expect(flushedBlobs).toBe(true);
              return yield* systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "link",
                pathOrDescriptor: to,
              });
            }
            yield* f.fs.link(from, to);
          }),
      });
      yield* Effect.gen(function* () {
        const store = yield* openStore(f.directory);
        expect(yield* Effect.flip(store.putTree(tree))).toMatchObject({
          _tag: "History.StoreFailed",
        });
      }).pipe(Effect.provideService(FileSystem.FileSystem, files));
      expect(stopped).toBe(true);
      expect(yield* f.fs.exists(manifest)).toBe(false);
      const cold = yield* openStore(f.directory);
      expect(yield* Effect.flip(cold.tree(id))).toMatchObject({ _tag: "History.StoreMissing" });
      expect(yield* cold.putTree(tree)).toBe(id);
      expect(yield* cold.tree(id)).toEqual(tree);
      expect(yield* f.fs.readDirectory(f.blobs)).toHaveLength(1);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "concurrent tree publishers share blobs and leave every tree independently readable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const stores = yield* Effect.all([openStore(f.directory), openStore(f.directory)]);
      const trees = [0, 1, 2, 3].map((index) => [file(`file-${index}`, "same bytes")]);
      const ids = yield* Effect.forEach(trees, (tree, index) => stores[index % 2].putTree(tree), {
        concurrency: "unbounded",
      });
      expect(new Set(ids).size).toBe(4);
      expect(yield* f.fs.readDirectory(f.blobs)).toHaveLength(1);
      const cold = yield* openStore(f.directory);
      for (const [index, id] of ids.entries()) expect(yield* cold.tree(id)).toEqual(trees[index]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed metadata transaction leaves durable bytes and retries without a partial tree",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* prepareLibraryDatabase(dirname(f.directory), true);
      yield* withLibraryDatabase(
        f.database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_tree BEFORE INSERT ON author_tree_entries BEGIN SELECT RAISE(ABORT,'refused'); END`;
        }),
      );
      const tree = [file("notes.txt", "durable before metadata")];
      const id = yield* History.treeHash(tree);
      const store = yield* openStore(f.directory);
      expect(yield* Effect.flip(store.putTree(tree))).toMatchObject({
        _tag: "History.StoreFailed",
      });
      expect(yield* f.fs.readDirectory(f.blobs)).toHaveLength(1);
      yield* withLibraryDatabase(
        f.database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT * FROM author_trees`).toEqual([]);
          expect(yield* sql`SELECT * FROM author_tree_entries`).toEqual([]);
          expect(yield* sql`SELECT * FROM file_bytes`).toEqual([]);
          yield* sql`DROP TRIGGER refuse_tree`;
        }),
      );
      const cold = yield* openStore(f.directory);
      expect(yield* cold.hasTree(id)).toBe(false);
      expect(yield* cold.putTree(tree)).toBe(id);
      expect(yield* cold.tree(id)).toEqual(tree);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
