import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Hash } from "../shared/hash.js";
import * as History from "../history/history.js";

const Entry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    mode: Schema.Literals([420, 493]),
    blob: Hash,
  }),
  Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    path: Schema.String,
    target: Schema.String,
  }),
]);
const EntryRow = Schema.Union([
  Schema.Struct({
    position: Schema.Int,
    path: Schema.String,
    kind: Schema.Literal("file"),
    mode: Schema.Literals([420, 493]),
    blob: Hash,
    target: Schema.Null,
  }),
  Schema.Struct({
    position: Schema.Int,
    path: Schema.String,
    kind: Schema.Literal("directory"),
    mode: Schema.Null,
    blob: Schema.Null,
    target: Schema.Null,
  }),
  Schema.Struct({
    position: Schema.Int,
    path: Schema.String,
    kind: Schema.Literal("symlink"),
    mode: Schema.Null,
    blob: Schema.Null,
    target: Schema.String,
  }),
]);
export type StoredEntry = typeof Entry.Type;
export interface StoredTree {
  readonly entries: readonly StoredEntry[];
}
export interface StoredRevision {
  readonly revision: History.Revision;
}

export const hasHistoryRows = Effect.fn("AuthorHistory.hasRows")(function* (
  kind: History.Kind,
  hash: Hash,
) {
  const sql = yield* SqlClient.SqlClient;
  return kind === "tree"
    ? (yield* sql`SELECT hash FROM author_trees WHERE hash=${hash} LIMIT 1`).length > 0
    : (yield* sql`SELECT hash FROM author_revisions WHERE hash=${hash} LIMIT 1`).length > 0;
});

/** Find stored identities for a batch of hashes. */
export const knownHistoryRows = Effect.fn("AuthorHistory.knownRows")(function* (
  kind: History.Kind,
  hashes: readonly Hash[],
) {
  const sql = yield* SqlClient.SqlClient;
  const find = SqlSchema.findAll({
    Request: Schema.Array(Hash),
    Result: Schema.Struct({ hash: Hash }),
    execute: (ids) =>
      kind === "tree"
        ? sql`SELECT hash FROM author_trees WHERE hash IN ${sql.in(ids)}`
        : sql`SELECT hash FROM author_revisions WHERE hash IN ${sql.in(ids)}`,
  });
  const known = new Set<Hash>();
  const unique = [...new Set(hashes)];
  for (let start = 0; start < unique.length; start += 500)
    for (const row of yield* find(unique.slice(start, start + 500))) known.add(row.hash);
  return known;
});

export const listHistoryRows = Effect.fn("AuthorHistory.listRows")(function* (kind: History.Kind) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ hash: Hash })))(
    kind === "tree"
      ? yield* sql`SELECT hash FROM author_trees ORDER BY hash`
      : yield* sql`SELECT hash FROM author_revisions ORDER BY hash`,
  );
  return rows.map((row) => row.hash);
});

export const loadTreeRows = Effect.fn("AuthorHistory.loadTreeRows")(function* (hash: Hash) {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* sql`SELECT hash FROM author_trees WHERE hash=${hash}`).length === 0) return undefined;
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(EntryRow))(
    yield* sql`SELECT * FROM author_tree_entries WHERE tree_hash=${hash} ORDER BY position`,
  );
  const entries = yield* Effect.forEach(rows, (row, index) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(Schema.Literal(index))(row.position);
      return yield* Schema.decodeUnknownEffect(Entry)({
        kind: row.kind,
        path: row.path,
        ...(row.kind === "file"
          ? { mode: row.mode, blob: row.blob }
          : row.kind === "symlink"
            ? { target: row.target }
            : {}),
      });
    }),
  );
  return { entries } satisfies StoredTree;
});

/** Immutable insertion leaves an existing value (including corrupt evidence) untouched. */
export const saveTreeRows = Effect.fn("AuthorHistory.saveTreeRows")(function* (
  hash: Hash,
  tree: StoredTree,
) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasHistoryRows("tree", hash)) return;
  yield* sql`INSERT INTO author_trees(hash) VALUES(${hash})`;
  for (const [position, entry] of tree.entries.entries())
    yield* sql`INSERT INTO author_tree_entries(tree_hash,position,path,kind,mode,blob,target)
      VALUES(${hash},${position},${entry.path},${entry.kind},${entry.kind === "file" ? entry.mode : null},${entry.kind === "file" ? entry.blob : null},${entry.kind === "symlink" ? entry.target : null})`;
});

export const loadRevisionRows = Effect.fn("AuthorHistory.loadRevisionRows")(function* (hash: Hash) {
  const sql = yield* SqlClient.SqlClient;
  const header = (yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        tree_hash: History.TreeHash,
        author_device: Schema.String,
        author_at: Schema.Int,
        edits_json: Schema.String,
      }),
    ),
  )(yield* sql`SELECT * FROM author_revisions WHERE hash=${hash}`))[0];
  if (!header) return undefined;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        position: Schema.Int,
        parent_hash: History.RevisionId,
      }),
    ),
  )(
    yield* sql`SELECT position,parent_hash FROM author_revision_parents WHERE revision_hash=${hash} ORDER BY position`,
  );
  const parents = yield* Effect.forEach(rows, (row, index) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(Schema.Literal(index))(row.position);
      return yield* Schema.decodeUnknownEffect(History.RevisionId)(row.parent_hash);
    }),
  );
  const revision = yield* Schema.decodeUnknownEffect(History.Revision)({
    edits: yield* Schema.decodeEffect(Schema.fromJsonString(History.EditTimes))(header.edits_json),
    tree: header.tree_hash,
    parents,
    author: { device: header.author_device, at: header.author_at },
  });
  return { revision } satisfies StoredRevision;
});

export const saveRevisionRows = Effect.fn("AuthorHistory.saveRevisionRows")(function* (
  hash: Hash,
  stored: StoredRevision,
) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasHistoryRows("revision", hash)) return;
  const revision = stored.revision;
  yield* sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,edits_json)
    VALUES(${hash},${revision.tree},${revision.author.device},${revision.author.at},${JSON.stringify(revision.edits)})`;
  for (const [position, parent] of revision.parents.entries())
    yield* sql`INSERT INTO author_revision_parents(revision_hash,position,parent_hash) VALUES(${hash},${position},${parent})`;
});
