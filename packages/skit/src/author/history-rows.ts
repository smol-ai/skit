import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { JsonObject } from "../shared/json.js";
import { Hash } from "../shared/hash.js";
import * as History from "../history/history.js";

const Entry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    mode: Schema.Literals([420, 493]),
    blob: Hash,
    extra: JsonObject,
  }),
  Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String, extra: JsonObject }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    path: Schema.String,
    target: Schema.String,
    extra: JsonObject,
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
    extra: Schema.String,
  }),
  Schema.Struct({
    position: Schema.Int,
    path: Schema.String,
    kind: Schema.Literal("directory"),
    mode: Schema.Null,
    blob: Schema.Null,
    target: Schema.Null,
    extra: Schema.String,
  }),
  Schema.Struct({
    position: Schema.Int,
    path: Schema.String,
    kind: Schema.Literal("symlink"),
    mode: Schema.Null,
    blob: Schema.Null,
    target: Schema.String,
    extra: Schema.String,
  }),
]);
export type StoredEntry = typeof Entry.Type;
export interface StoredTree {
  readonly entries: readonly StoredEntry[];
  readonly extra: JsonObject;
}
export interface StoredRevision {
  readonly revision: History.Revision;
  readonly extra: JsonObject;
  readonly authorExtra: JsonObject;
}

export const hasHistoryRows = Effect.fn("AuthorHistory.hasRows")(function* (
  kind: History.Kind,
  hash: Hash,
) {
  const sql = yield* SqlClient.SqlClient;
  return kind === "tree"
    ? (yield* sql`SELECT hash FROM author_trees WHERE hash=${hash} UNION ALL SELECT hash FROM author_history_legacy_documents WHERE kind='tree' AND hash=${hash} LIMIT 1`)
        .length > 0
    : (yield* sql`SELECT hash FROM author_revisions WHERE hash=${hash} UNION ALL SELECT hash FROM author_history_legacy_documents WHERE kind='revision' AND hash=${hash} LIMIT 1`)
        .length > 0;
});

/** Query only the source identities being imported, including unreadable legacy evidence. */
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
        ? sql`SELECT hash FROM author_trees WHERE hash IN ${sql.in(ids)} UNION SELECT hash FROM author_history_legacy_documents WHERE kind='tree' AND hash IN ${sql.in(ids)}`
        : sql`SELECT hash FROM author_revisions WHERE hash IN ${sql.in(ids)} UNION SELECT hash FROM author_history_legacy_documents WHERE kind='revision' AND hash IN ${sql.in(ids)}`,
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
      ? yield* sql`SELECT hash FROM author_trees UNION SELECT hash FROM author_history_legacy_documents WHERE kind='tree' ORDER BY hash`
      : yield* sql`SELECT hash FROM author_revisions UNION SELECT hash FROM author_history_legacy_documents WHERE kind='revision' ORDER BY hash`,
  );
  return rows.map((row) => row.hash);
});

export const loadLegacyHistoryDocument = Effect.fn("AuthorHistory.loadUnreadable")(function* (
  kind: History.Kind,
  hash: Hash,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ document: Schema.String })),
  )(
    yield* sql`SELECT document FROM author_history_legacy_documents WHERE kind=${kind} AND hash=${hash}`,
  );
  return rows[0]?.document;
});

export const saveLegacyHistoryDocument = Effect.fn("AuthorHistory.saveUnreadable")(function* (
  kind: History.Kind,
  hash: Hash,
  text: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasHistoryRows(kind, hash)) return;
  yield* sql`INSERT INTO author_history_legacy_documents(kind,hash,document) VALUES(${kind},${hash},${text})`;
});

/** Header and children are read in the caller's snapshot and decoded before any file access. */
export const loadTreeRows = Effect.fn("AuthorHistory.loadTreeRows")(function* (hash: Hash) {
  const sql = yield* SqlClient.SqlClient;
  const header = (yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ extra: Schema.String })),
  )(yield* sql`SELECT extra FROM author_trees WHERE hash=${hash}`))[0];
  if (!header) return undefined;
  const extra = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(header.extra);
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(EntryRow))(
    yield* sql`SELECT * FROM author_tree_entries WHERE tree_hash=${hash} ORDER BY position`,
  );
  const entries = yield* Effect.forEach(rows, (row, index) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(Schema.Literal(index))(row.position);
      const extra = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(row.extra);
      return yield* Schema.decodeUnknownEffect(Entry)({
        kind: row.kind,
        path: row.path,
        extra,
        ...(row.kind === "file"
          ? { mode: row.mode, blob: row.blob }
          : row.kind === "symlink"
            ? { target: row.target }
            : {}),
      });
    }),
  );
  return { entries, extra } satisfies StoredTree;
});

/** Immutable insertion leaves an existing value (including corrupt evidence) untouched. */
export const saveTreeRows = Effect.fn("AuthorHistory.saveTreeRows")(function* (
  hash: Hash,
  tree: StoredTree,
) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasHistoryRows("tree", hash)) return;
  yield* sql`INSERT INTO author_trees(hash,extra) VALUES(${hash},${JSON.stringify(tree.extra)})`;
  for (const [position, entry] of tree.entries.entries())
    yield* sql`INSERT INTO author_tree_entries(tree_hash,position,path,kind,mode,blob,target,extra)
      VALUES(${hash},${position},${entry.path},${entry.kind},${entry.kind === "file" ? entry.mode : null},${entry.kind === "file" ? entry.blob : null},${entry.kind === "symlink" ? entry.target : null},${JSON.stringify(entry.extra)})`;
});

export const loadRevisionRows = Effect.fn("AuthorHistory.loadRevisionRows")(function* (hash: Hash) {
  const sql = yield* SqlClient.SqlClient;
  const header = (yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        tree_hash: History.TreeHash,
        author_device: Schema.String,
        author_at: Schema.Int,
        extra: Schema.String,
        author_extra: Schema.String,
        edits_json: Schema.String,
      }),
    ),
  )(yield* sql`SELECT * FROM author_revisions WHERE hash=${hash}`))[0];
  if (!header) return undefined;
  const extra = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(header.extra);
  const authorExtra = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
    header.author_extra,
  );
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
  return { revision, extra, authorExtra } satisfies StoredRevision;
});

export const saveRevisionRows = Effect.fn("AuthorHistory.saveRevisionRows")(function* (
  hash: Hash,
  stored: StoredRevision,
  source?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasHistoryRows("revision", hash)) return;
  const revision = stored.revision;
  // Revision-only imports remain readable evidence. No tree identity is inferred or invented.
  if ((yield* sql`SELECT hash FROM author_trees WHERE hash=${revision.tree}`).length === 0) {
    yield* saveLegacyHistoryDocument(
      "revision",
      hash,
      source ??
        JSON.stringify({
          ...stored.extra,
          ...revision,
          author: { ...stored.authorExtra, ...revision.author },
        }),
    );
    return;
  }
  yield* sql`INSERT INTO author_revisions(hash,tree_hash,author_device,author_at,extra,author_extra,edits_json)
    VALUES(${hash},${revision.tree},${revision.author.device},${revision.author.at},${JSON.stringify(stored.extra)},${JSON.stringify(stored.authorExtra)},${JSON.stringify(revision.edits)})`;
  for (const [position, parent] of revision.parents.entries())
    yield* sql`INSERT INTO author_revision_parents(revision_hash,position,parent_hash) VALUES(${hash},${position},${parent})`;
});
