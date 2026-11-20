import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../../src/library/store/database.js";

/** Reconstruct the pre-014 residual layout from declared, valid fixture rows. */
export const schema013 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    "library_collections",
    "library_skills",
    "library_skill_versions",
    "library_collection_versions",
    "library_collection_version_members",
    "library_imports",
    "library_enabled",
    "library_repositories",
    "library_installed_skills",
    "library_assessment_acceptances",
    "library_device",
    "library_sync",
    "library_unmanaged_skills",
    "library_ownership_issues",
    "library_scan_issues",
    "machine",
    "machine_repositories",
    "author_history_workspaces",
    "author_history_events",
    "author_trees",
    "author_tree_entries",
    "author_revisions",
    "author_state_fields",
    "author_sync_checkpoints",
    "author_inventories",
  ];
  for (const table of tables)
    yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN extra TEXT DEFAULT '{}'`;
  yield* sql`ALTER TABLE author_revisions ADD COLUMN author_extra TEXT DEFAULT '{}'`;
  yield* sql`ALTER TABLE author_inventories ADD COLUMN inventory_extra TEXT DEFAULT '{}'`;
  yield* sql`ALTER TABLE author_sync_checkpoints ADD COLUMN next_extra TEXT`;
  yield* sql`UPDATE author_sync_checkpoints SET next_extra='{}' WHERE status='Writing'`;
  yield* sql`UPDATE library_device SET extra=json_object('schemaVersion',schema_version)`;
  yield* sql`UPDATE library_device SET extra=json_set(extra,'$.assessmentAcceptances',json('[]')) WHERE assessment_acceptances_present=1`;
  yield* sql`UPDATE library_device SET extra=json_set(extra,'$.invocation_policies',json('{}')) WHERE invocation_policies_present=1`;
  yield* sql`UPDATE library_device SET extra=json_set(extra,'$.device_skill_selection',json('{"invocation_policies":{}}')) WHERE device_invocation_policies_present=1`;
  yield* sql`UPDATE library_repositories SET extra='{"invocation_policies":{}}' WHERE invocation_policies_present=1`;
  yield* sql`UPDATE library_imports SET extra='{"input":{}}'`;
  yield* sql`UPDATE library_sync SET extra=json_object('base_manifest',json_object('schema',base_schema,'snapshot_digests',json(snapshot_digests)))`;
  yield* sql`ALTER TABLE machine ADD COLUMN legacy_machine_id TEXT`;
  yield* sql`UPDATE machine SET extra=json_object('schemaVersion',schema_version)`;
  yield* sql`UPDATE machine SET legacy_machine_id=json_extract(legacy_machine_id_json,'$') WHERE json_type(legacy_machine_id_json)='text'`;
  yield* sql`UPDATE machine SET extra=json_set(extra,'$.legacyMachineId',json(legacy_machine_id_json)) WHERE legacy_machine_id_json IS NOT NULL AND json_type(legacy_machine_id_json)<>'text'`;
  for (const [table, columns] of [
    [
      "library_device",
      [
        "schema_version",
        "assessment_acceptances_present",
        "invocation_policies_present",
        "device_invocation_policies_present",
      ],
    ],
    ["library_repositories", ["invocation_policies_present"]],
    ["library_sync", ["base_schema", "snapshot_digests"]],
    ["machine", ["schema_version", "legacy_machine_id_json"]],
  ] satisfies ReadonlyArray<readonly [string, readonly string[]]>)
    for (const column of columns) yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN ${sql(column)}`;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id>=14`;
});
export const database013 = (home: string) =>
  withLibraryDatabase(
    libraryDatabasePath(home),
    Effect.gen(function* () {
      return yield* (yield* SqlClient.SqlClient).withTransaction(schema013);
    }),
  );
