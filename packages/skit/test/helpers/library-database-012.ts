import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../../src/library/store/database.js";

/** Reconstruct the three pre-013 tables, keeping the fixture's other owner data intact. */
export const schema012 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`ALTER TABLE author_history_legacy_documents DROP COLUMN source_rows`;
      yield* sql`CREATE TEMP TABLE installed_012 AS SELECT * FROM library_installed_skills`;
      yield* sql`CREATE TEMP TABLE acceptances_012 AS SELECT * FROM library_assessment_acceptances ORDER BY rowid`;
      yield* sql`CREATE TEMP TABLE revisions_012 AS SELECT hash,tree_hash,author_device,author_at,json_set(extra,'$.edits',json(edits_json)) AS extra,author_extra FROM author_revisions`;
      yield* sql`CREATE TEMP TABLE parents_012 AS SELECT * FROM author_revision_parents`;
      yield* sql`DROP TABLE library_installed_skills`;
      yield* sql`DROP TABLE library_assessment_acceptances`;
      yield* sql`DROP INDEX library_skill_version_owners`;
      yield* sql`DROP TABLE author_revision_parents`;
      yield* sql`DROP TABLE author_revisions`;
      // Frozen 012 shapes: no installed/acceptance/tree FKs and no explicit revision edits.
      yield* sql`CREATE TABLE library_installed_skills (
      installed_skill_id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,skill_version_id TEXT NOT NULL,
      destination TEXT NOT NULL,root TEXT NOT NULL,path TEXT NOT NULL UNIQUE,
      expected_hash TEXT NOT NULL,installed_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('installed','pending','conflicted','suppressed')),
      current_hash TEXT,conflicts TEXT CHECK(conflicts IS NULL OR json_valid(conflicts)),
      suppression_reason TEXT,suppressed_at TEXT,extra TEXT
    ) STRICT`;
      yield* sql`CREATE TABLE library_assessment_acceptances (
      fingerprint TEXT NOT NULL,artifact_content_hash TEXT NOT NULL,skill_version_id TEXT NOT NULL,
      context TEXT NOT NULL,principal TEXT NOT NULL,rationale TEXT NOT NULL,accepted_at TEXT NOT NULL,
      expires_at TEXT,extra TEXT
    ) STRICT`;
      yield* sql`CREATE TABLE author_revisions (
      hash TEXT PRIMARY KEY,tree_hash TEXT NOT NULL,author_device TEXT NOT NULL,author_at INTEGER NOT NULL,
      extra TEXT NOT NULL CHECK(json_valid(extra)),author_extra TEXT NOT NULL CHECK(json_valid(author_extra))
    ) STRICT`;
      yield* sql`CREATE TABLE author_revision_parents (
      revision_hash TEXT NOT NULL REFERENCES author_revisions(hash),position INTEGER NOT NULL CHECK(position>=0),
      parent_hash TEXT NOT NULL,PRIMARY KEY(revision_hash,position)
    ) STRICT`;
      yield* sql`INSERT INTO library_installed_skills SELECT * FROM installed_012`;
      yield* sql`INSERT INTO library_assessment_acceptances SELECT * FROM acceptances_012`;
      yield* sql`INSERT INTO author_revisions SELECT * FROM revisions_012`;
      yield* sql`INSERT INTO author_revision_parents SELECT * FROM parents_012`;
      yield* sql`DROP TABLE installed_012`;
      yield* sql`DROP TABLE acceptances_012`;
      yield* sql`DROP TABLE revisions_012`;
      yield* sql`DROP TABLE parents_012`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id>=13`;
    }),
  );
});

export const database012 = (home: string) =>
  withLibraryDatabase(libraryDatabasePath(home), schema012);
