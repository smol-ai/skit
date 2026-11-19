import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Author owns this timeline; it is separate from Library audit and setup undo. */
export const createAuthorHistoryTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE author_history_workspaces (
    workspace_key TEXT PRIMARY KEY,workspace_id TEXT UNIQUE,root TEXT NOT NULL,
    extra TEXT NOT NULL CHECK(json_valid(extra))
  ) STRICT`;
  yield* sql`CREATE INDEX author_history_workspace_roots ON author_history_workspaces(root)`;
  yield* sql`CREATE TABLE author_history_events (
    workspace_key TEXT NOT NULL REFERENCES author_history_workspaces(workspace_key),
    sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=9007199254740991),
    revision TEXT NOT NULL,root TEXT NOT NULL,workspace_id TEXT,
    extra TEXT NOT NULL CHECK(json_valid(extra)),PRIMARY KEY(workspace_key,sequence)
  ) STRICT`;
  yield* sql`CREATE TABLE author_history_import (
    id INTEGER PRIMARY KEY CHECK(id=1),source_hash TEXT
  ) STRICT`;
});

/** Immutable metadata has ordered child rows; parents may be absent in a shallow history. */
export const createAuthorMetadataTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE author_trees(hash TEXT PRIMARY KEY,extra TEXT NOT NULL CHECK(json_valid(extra))) STRICT`;
  yield* sql`CREATE TABLE author_tree_entries(
    tree_hash TEXT NOT NULL REFERENCES author_trees(hash),position INTEGER NOT NULL CHECK(position>=0),
    path TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','directory','symlink')),
    mode INTEGER,blob TEXT,target TEXT,extra TEXT NOT NULL CHECK(json_valid(extra)),
    PRIMARY KEY(tree_hash,position),
    CHECK((kind='file' AND mode IN (420,493) AND blob IS NOT NULL AND target IS NULL)
      OR (kind='directory' AND mode IS NULL AND blob IS NULL AND target IS NULL)
      OR (kind='symlink' AND mode IS NULL AND blob IS NULL AND target IS NOT NULL))
  ) STRICT`;
  yield* sql`CREATE TABLE author_revisions(
    hash TEXT PRIMARY KEY,tree_hash TEXT NOT NULL,author_device TEXT NOT NULL,author_at INTEGER NOT NULL,
    extra TEXT NOT NULL CHECK(json_valid(extra)),author_extra TEXT NOT NULL CHECK(json_valid(author_extra))
  ) STRICT`;
  yield* sql`CREATE TABLE author_revision_parents(
    revision_hash TEXT NOT NULL REFERENCES author_revisions(hash),position INTEGER NOT NULL CHECK(position>=0),
    parent_hash TEXT NOT NULL,PRIMARY KEY(revision_hash,position)
  ) STRICT`;
  yield* sql`CREATE TABLE author_history_legacy_documents(
    kind TEXT NOT NULL CHECK(kind IN ('tree','revision')),hash TEXT NOT NULL,document TEXT NOT NULL,
    PRIMARY KEY(kind,hash)
  ) STRICT`;
  yield* sql`CREATE TABLE author_metadata_import(id INTEGER PRIMARY KEY CHECK(id=1),source_hash TEXT NOT NULL) STRICT`;
});
