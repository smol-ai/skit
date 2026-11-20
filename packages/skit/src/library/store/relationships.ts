import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Migration 013: ownership is a pair, not two unrelated references. */
export const migrateLibraryRelationships = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE UNIQUE INDEX library_skill_version_owners ON library_skill_versions(skill_id,skill_version_id)`;
  yield* sql`CREATE TABLE library_installed_skills_next (
    installed_skill_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,skill_version_id TEXT NOT NULL,
    destination TEXT NOT NULL,root TEXT NOT NULL,path TEXT NOT NULL UNIQUE,
    expected_hash TEXT NOT NULL,installed_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('installed','pending','conflicted','suppressed')),
    current_hash TEXT,conflicts TEXT CHECK(conflicts IS NULL OR json_valid(conflicts)),
    suppression_reason TEXT,suppressed_at TEXT,extra TEXT,
    FOREIGN KEY(skill_id,skill_version_id) REFERENCES library_skill_versions(skill_id,skill_version_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`;
  yield* sql`INSERT INTO library_installed_skills_next SELECT * FROM library_installed_skills`;
  yield* sql`DROP TABLE library_installed_skills`;
  yield* sql`ALTER TABLE library_installed_skills_next RENAME TO library_installed_skills`;
  // Assessment acceptances are consent evidence kept after their Version is removed.
  // They deliberately have no foreign key to the live catalogue.
});
