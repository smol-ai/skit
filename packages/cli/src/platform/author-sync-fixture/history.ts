import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SqlClient } from "effect/sql";
import { sqliteLayer } from "@smolai/skit-core/platform";
import * as History from "@smolai/skit-core/history";
import { authorLayer as owners, refreshAuthorWorkspace } from "@smolai/skit-core/author";

export const authorLayer = (home: string) => Layer.fresh(owners({ home }));
export const refreshWorkspace = refreshAuthorWorkspace;

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.author-tree.v1"),
    entries: Schema.Array(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("file"),
          path: Schema.String,
          mode: Schema.Literals([0o644, 0o755]),
          blob: Schema.String,
        }),
        Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String }),
        Schema.Struct({
          kind: Schema.Literal("symlink"),
          path: Schema.String,
          target: Schema.String,
        }),
      ]),
    ),
  }),
);

/** Independent SQL evidence; this never calls the owner or imports legacy state. */
const nativeMetadata = Effect.fn("Fixture.nativeHistoryEvidence")(
  function* (fs: FileSystem.FileSystem, home: string, kind: History.Kind, hash?: string) {
    const filename = join(home, "library.sqlite");
    if (!(yield* fs.exists(filename))) return { text: undefined, hashes: [] };
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const hashes = (yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ hash: Schema.String })),
            )(
              kind === "tree"
                ? yield* sql`SELECT hash FROM author_trees ORDER BY hash`
                : yield* sql`SELECT hash FROM author_revisions ORDER BY hash`,
            )).map((row) => row.hash);
            if (hash === undefined) return { text: undefined, hashes };
            if (kind === "revision") {
              const rows =
                yield* sql`SELECT tree_hash,author_device,author_at,edits_json FROM author_revisions WHERE hash=${hash}`;
              if (rows[0] !== undefined) {
                const row = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({
                    tree_hash: Schema.String,
                    author_device: Schema.String,
                    author_at: Schema.Int,
                    edits_json: Schema.String,
                  }),
                )(rows[0]);
                const parents = yield* Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ position: Schema.Int, parent_hash: Schema.String })),
                )(
                  yield* sql`SELECT position,parent_hash FROM author_revision_parents WHERE revision_hash=${hash} ORDER BY position`,
                );
                for (const [index, parent] of parents.entries())
                  yield* Schema.decodeUnknownEffect(Schema.Literal(index))(parent.position);
                return {
                  hashes,
                  text: JSON.stringify({
                    edits: yield* Schema.decodeEffect(Schema.fromJsonString(History.EditTimes))(
                      row.edits_json,
                    ),
                    tree: row.tree_hash,
                    parents: parents.map((parent) => parent.parent_hash),
                    author: { device: row.author_device, at: row.author_at },
                  }),
                };
              }
            } else if ((yield* sql`SELECT hash FROM author_trees WHERE hash=${hash}`).length > 0) {
              const rows = yield* Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    position: Schema.Int,
                    path: Schema.String,
                    kind: Schema.Literals(["file", "directory", "symlink"]),
                    mode: Schema.NullOr(Schema.Int),
                    blob: Schema.NullOr(Schema.String),
                    target: Schema.NullOr(Schema.String),
                  }),
                ),
              )(
                yield* sql`SELECT position,path,kind,mode,blob,target FROM author_tree_entries WHERE tree_hash=${hash} ORDER BY position`,
              );
              for (const [index, row] of rows.entries())
                yield* Schema.decodeUnknownEffect(Schema.Literal(index))(row.position);
              return {
                hashes,
                text: JSON.stringify({
                  schema: "skit.author-tree.v1",
                  entries: rows.map((row) => ({
                    kind: row.kind,
                    path: row.path,
                    ...(row.kind === "file"
                      ? { mode: row.mode, blob: row.blob }
                      : row.kind === "symlink"
                        ? { target: row.target }
                        : {}),
                  })),
                }),
              };
            }
            return { hashes, text: undefined };
          }),
        );
      }).pipe(Effect.provide(sqliteLayer({ filename, readonly: true }))),
    );
  },
  Effect.mapError((cause) => new History.StoreFailed({ cause })),
);

/** Independent, read-only disk evidence. It cannot obtain an Author lease or mutate a store. */
const historyAt = Effect.fn("Fixture.historyEvidence")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const failed = (cause: unknown) => new History.StoreFailed({ cause });
  const store = yield* History.makeStore({
    read: (kind, hash) =>
      Effect.gen(function* () {
        const text = Option.fromUndefinedOr((yield* nativeMetadata(fs, home, kind, hash)).text);
        if (kind !== "tree" || Option.isNone(text)) return text;
        const manifest = Schema.decodeOption(Manifest)(text.value);
        if (Option.isNone(manifest)) return text;
        const tree = yield* Effect.forEach(manifest.value.entries, (entry) =>
          Effect.gen(function* () {
            if (entry.kind !== "file") return entry;
            const canonical = join(home, "file-bytes", entry.blob.slice(7));
            const bytes = yield* fs.readFile(canonical).pipe(Effect.mapError(failed));
            if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.blob)
              return yield* new History.StoreCorrupt({
                kind,
                hash,
                reason: {
                  _tag: "BlobHashMismatch",
                  blob: entry.blob,
                  actual: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                },
              });
            return { kind: entry.kind, path: entry.path, mode: entry.mode, bytes };
          }),
        );
        return Option.some(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(History.Tree)))(
            tree,
          ).pipe(Effect.orDie),
        );
      }),
    write: () => Effect.die("History evidence is read-only"),
    has: (kind, hash) =>
      Effect.gen(function* () {
        const native = yield* nativeMetadata(fs, home, kind, hash);
        return native.text !== undefined;
      }),
    list: (kind) =>
      Effect.gen(function* () {
        const native = yield* nativeMetadata(fs, home, kind);
        return yield* Effect.forEach(native.hashes, (hash) =>
          Schema.decodeEffect(History.TreeHash)(hash),
        ).pipe(Effect.mapError(failed));
      }),
  });
  return store;
});

export const storedTreesAt = (home: string) =>
  Effect.gen(function* () {
    const store = yield* historyAt(home);
    return yield* Effect.forEach(yield* store.trees, (hash) =>
      Effect.map(store.tree(hash), (tree) => ({ hash, tree })),
    );
  });
export const readAuthorTree = (
  observation: { readonly treeHash: History.TreeHash },
  home: string,
) => Effect.flatMap(historyAt(home), (store) => store.tree(observation.treeHash));
export const readAuthorRevision = (home: string, id: History.RevisionId) =>
  Effect.flatMap(historyAt(home), (store) => store.revision(id));
export const readAuthorAncestors = (home: string, id: History.RevisionId) =>
  Effect.flatMap(historyAt(home), (store) => Stream.runCollect(History.ancestors(store, id)));
