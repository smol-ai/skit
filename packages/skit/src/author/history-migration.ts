import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as History from "../history/history.js";
import { JsonObject } from "../shared/json.js";

/**
 * Migration 013 only. Revision-only metadata is valid: keep it as a readable document plus
 * the exact original SQL rows as evidence. Invalid edit maps or parent positions refuse the
 * entire transaction. No tree is inferred, and shallow parents never require local targets.
 */
export const migrateAuthorRevisionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        hash: Schema.String,
        tree_hash: Schema.String,
        author_device: Schema.String,
        author_at: Schema.Int,
        extra: Schema.String,
        author_extra: Schema.String,
      }),
    ),
  )(yield* sql`SELECT * FROM author_revisions`);
  yield* sql`ALTER TABLE author_history_legacy_documents ADD COLUMN source_rows TEXT CHECK(source_rows IS NULL OR json_valid(source_rows))`;
  const orphans =
    yield* sql`SELECT p.revision_hash FROM author_revision_parents p LEFT JOIN author_revisions r ON r.hash=p.revision_hash WHERE r.hash IS NULL`;
  yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Never))(orphans);
  yield* sql`CREATE TABLE author_revisions_next (
    hash TEXT PRIMARY KEY,
    tree_hash TEXT NOT NULL REFERENCES author_trees(hash) DEFERRABLE INITIALLY DEFERRED,
    author_device TEXT NOT NULL,author_at INTEGER NOT NULL,
    extra TEXT NOT NULL CHECK(json_valid(extra)),author_extra TEXT NOT NULL CHECK(json_valid(author_extra)),
    edits_json TEXT NOT NULL CHECK(json_valid(edits_json) AND json_type(edits_json)='object')
  ) STRICT`;
  for (const row of rows) {
    const extra = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(row.extra);
    const edits = yield* Schema.decodeUnknownEffect(History.EditTimes)(extra.edits);
    const residual = Object.fromEntries(
      Object.entries(extra).filter(([field]) => field !== "edits"),
    );
    if ((yield* sql`SELECT hash FROM author_trees WHERE hash=${row.tree_hash}`).length === 0) {
      const parents = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            revision_hash: Schema.String,
            position: Schema.Int,
            parent_hash: History.RevisionId,
          }),
        ),
      )(
        yield* sql`SELECT * FROM author_revision_parents WHERE revision_hash=${row.hash} ORDER BY position`,
      );
      for (const [index, parent] of parents.entries())
        yield* Schema.decodeUnknownEffect(Schema.Literal(index))(parent.position);
      const authorExtra = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(
        row.author_extra,
      );
      const revision = yield* Schema.decodeUnknownEffect(History.Revision)({
        tree: row.tree_hash,
        parents: parents.map((parent) => parent.parent_hash),
        author: { device: row.author_device, at: row.author_at },
        edits,
      });
      const document = JSON.stringify({
        ...extra,
        ...revision,
        author: { ...authorExtra, ...revision.author },
      });
      // The document matches the old owner read. Original strings, including JSON formatting,
      // stay separately as evidence; an existing conflicting document refuses via its unique key.
      yield* sql`INSERT INTO author_history_legacy_documents(kind,hash,document,source_rows)
        VALUES('revision',${row.hash},${document},${JSON.stringify({ revision: row, parents })})`;
      continue;
    }
    yield* sql`INSERT INTO author_revisions_next(hash,tree_hash,author_device,author_at,extra,author_extra,edits_json)
      SELECT hash,tree_hash,author_device,author_at,${JSON.stringify(residual)},author_extra,${JSON.stringify(edits)}
      FROM author_revisions WHERE hash=${row.hash}`;
  }
  yield* sql`CREATE TABLE author_revision_parents_next (
    revision_hash TEXT NOT NULL REFERENCES author_revisions_next(hash) DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK(position>=0),parent_hash TEXT NOT NULL,
    PRIMARY KEY(revision_hash,position)
  ) STRICT`;
  // Parent order, duplicate parents and absent shallow ancestors are intentional.
  yield* sql`INSERT INTO author_revision_parents_next SELECT p.* FROM author_revision_parents p JOIN author_revisions_next r ON r.hash=p.revision_hash`;
  yield* sql`DROP TABLE author_revision_parents`;
  yield* sql`DROP TABLE author_revisions`;
  yield* sql`ALTER TABLE author_revisions_next RENAME TO author_revisions`;
  yield* sql`ALTER TABLE author_revision_parents_next RENAME TO author_revision_parents`;
});
