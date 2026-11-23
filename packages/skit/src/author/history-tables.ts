import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Author owns this timeline; it is separate from Library audit and setup undo. */
export const createAuthorHistoryTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE author_history_workspaces (
    workspace_key TEXT PRIMARY KEY,workspace_id TEXT UNIQUE,root TEXT NOT NULL) STRICT`;
  yield* sql`CREATE TABLE author_history_events (
    workspace_key TEXT NOT NULL REFERENCES author_history_workspaces(workspace_key),
    sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=9007199254740991),
    revision TEXT NOT NULL,root TEXT NOT NULL,workspace_id TEXT,PRIMARY KEY(workspace_key,sequence)
  ) STRICT`;
  yield* sql`CREATE INDEX author_history_workspace_roots ON author_history_workspaces(root)`;
});

/** Immutable metadata has ordered child rows; parents may be absent in a shallow history. */
export const createAuthorMetadataTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE author_trees(hash TEXT PRIMARY KEY) STRICT`;
  yield* sql`CREATE TABLE author_tree_entries(
    tree_hash TEXT NOT NULL REFERENCES author_trees(hash),position INTEGER NOT NULL CHECK(position>=0),
    path TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','directory','symlink')),
    mode INTEGER,blob TEXT,target TEXT,
    PRIMARY KEY(tree_hash,position),
    CHECK((kind='file' AND mode IN (420,493) AND blob IS NOT NULL AND target IS NULL)
      OR (kind='directory' AND mode IS NULL AND blob IS NULL AND target IS NULL)
      OR (kind='symlink' AND mode IS NULL AND blob IS NULL AND target IS NOT NULL))
  ) STRICT`;
  yield* sql`CREATE TABLE "author_revisions" (
    hash TEXT PRIMARY KEY,
    tree_hash TEXT NOT NULL REFERENCES author_trees(hash) DEFERRABLE INITIALLY DEFERRED,
    author_device TEXT NOT NULL,author_at INTEGER NOT NULL,
    edits_json TEXT NOT NULL CHECK(json_valid(edits_json) AND json_type(edits_json)='object')
  ) STRICT`;
  yield* sql`CREATE TABLE "author_revision_parents" (
    revision_hash TEXT NOT NULL REFERENCES "author_revisions"(hash) DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK(position>=0),parent_hash TEXT NOT NULL,
    PRIMARY KEY(revision_hash,position)
  ) STRICT`;
});
