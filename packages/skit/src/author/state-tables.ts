import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Author owns its checkpoints and inventories; Library's schema runner coordinates creation. */
export const createAuthorStateTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE author_state_import (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT, hash TEXT, backup TEXT) STRICT`;
  yield* sql`CREATE TABLE author_state_fields (id INTEGER PRIMARY KEY CHECK(id=1), inventories_present INTEGER NOT NULL CHECK(inventories_present IN (0,1)), backups_present INTEGER NOT NULL CHECK(backups_present IN (0,1)), extra TEXT NOT NULL CHECK(json_valid(extra))) STRICT`;
  yield* sql`CREATE TABLE author_workspace_state (workspace_id TEXT PRIMARY KEY, sync_present INTEGER NOT NULL CHECK(sync_present IN (0,1)), backup_present INTEGER NOT NULL CHECK(backup_present IN (0,1))) STRICT`;
  yield* sql`CREATE TABLE author_sync_checkpoints (
    workspace_id TEXT NOT NULL REFERENCES author_workspace_state(workspace_id), locator TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Idle','Sending','Writing')), base TEXT,
    revision TEXT, from_tree TEXT, to_tree TEXT, merged INTEGER CHECK(merged IN (0,1)),
    next_status TEXT CHECK(next_status IN ('Idle','Sending')), next_base TEXT, next_revision TEXT,
    extra TEXT NOT NULL CHECK(json_valid(extra)), next_extra TEXT CHECK(next_extra IS NULL OR json_valid(next_extra)),
    PRIMARY KEY(workspace_id,locator),
    CHECK((status='Idle' AND revision IS NULL AND from_tree IS NULL AND to_tree IS NULL AND merged IS NULL AND next_status IS NULL AND next_base IS NULL AND next_revision IS NULL AND next_extra IS NULL)
      OR (status='Sending' AND revision IS NOT NULL AND from_tree IS NULL AND to_tree IS NULL AND merged IS NULL AND next_status IS NULL AND next_base IS NULL AND next_revision IS NULL AND next_extra IS NULL)
      OR (status='Writing' AND revision IS NULL AND from_tree IS NOT NULL AND to_tree IS NOT NULL AND merged IS NOT NULL AND next_status IS NOT NULL AND next_extra IS NOT NULL AND ((next_status='Idle' AND next_base IS NOT NULL AND next_revision IS NULL) OR (next_status='Sending' AND next_revision IS NOT NULL))))
  ) STRICT`;
  yield* sql`CREATE TABLE author_backup_checkpoints (workspace_id TEXT NOT NULL REFERENCES author_workspace_state(workspace_id),locator TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(workspace_id,locator)) STRICT`;
  yield* sql`CREATE TABLE author_inventories (workspace_id TEXT PRIMARY KEY REFERENCES author_workspace_state(workspace_id),extra TEXT NOT NULL CHECK(json_valid(extra)), inventory_extra TEXT NOT NULL CHECK(json_valid(inventory_extra))) STRICT`;
  yield* sql`CREATE TABLE author_inventory_paths (workspace_id TEXT NOT NULL REFERENCES author_inventories(workspace_id), category TEXT NOT NULL CHECK(category IN ('files','members','removedFiles','removedMembers')), position INTEGER NOT NULL CHECK(position>=0),path TEXT NOT NULL,PRIMARY KEY(workspace_id,category,position)) STRICT`;
});
