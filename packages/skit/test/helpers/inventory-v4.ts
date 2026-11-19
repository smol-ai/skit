import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { LibraryState } from "../../src/library/library-state.js";

/** The exact inventory layout on this branch before migration 005; all other owner rows stay put. */
export const writeInventoryV4 = (
  state?: Pick<LibraryState, "unmanaged" | "ownershipIssues" | "scanIssues">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE library_unmanaged_paths`;
    yield* sql`DROP TABLE library_unmanaged_harnesses`;
    yield* sql`DROP TABLE library_ownership_issue_harnesses`;
    yield* sql`DROP TABLE library_unmanaged_skills`;
    yield* sql`DROP TABLE library_ownership_issues`;
    yield* sql`DROP TABLE library_scan_issues`;
    yield* sql`DROP TABLE library_inventory`;
    yield* sql`CREATE TABLE library_inventory (
    id INTEGER PRIMARY KEY CHECK(id=1),
    unmanaged TEXT CHECK(unmanaged IS NULL OR json_valid(unmanaged)),
    ownership_issues TEXT CHECK(ownership_issues IS NULL OR json_valid(ownership_issues)),
    scan_issues TEXT CHECK(scan_issues IS NULL OR json_valid(scan_issues))
  ) STRICT`;
    if (state)
      yield* sql`INSERT INTO library_inventory(id,unmanaged,ownership_issues,scan_issues) VALUES(1,${JSON.stringify(state.unmanaged)},${Object.hasOwn(state, "ownershipIssues") ? JSON.stringify(state.ownershipIssues) : null},${Object.hasOwn(state, "scanIssues") ? JSON.stringify(state.scanIssues) : null})`;
    yield* sql`DROP TABLE library_legacy_operations`;
    yield* sql`DROP TABLE library_legacy_history_import`;
    yield* sql`DROP TABLE library_history_compaction`;
    yield* sql`DROP TABLE author_history_events`;
    yield* sql`DROP TABLE author_history_workspaces`;
    yield* sql`DROP TABLE author_history_import`;
    yield* sql`DROP TABLE author_tree_entries`;
    yield* sql`DROP TABLE author_trees`;
    yield* sql`DROP TABLE author_revision_parents`;
    yield* sql`DROP TABLE author_revisions`;
    yield* sql`DROP TABLE author_history_legacy_documents`;
    yield* sql`DROP TABLE author_metadata_import`;
    yield* sql`DROP TABLE file_bytes`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id>=5`;
  });
