import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { InvalidLibraryState } from "../failures.js";
import { JsonObject } from "../../shared/json.js";

const invalid = (table: string, key: string) =>
  new InvalidLibraryState({
    path: "library.sqlite",
    reason: {
      _tag: "InvalidData",
      issue: `Migration 014 refuses unmodelled field ${table}.${key}; original database kept`,
    },
  });
const empty = Schema.Struct({});
const policies = Schema.optionalKey(empty);
const device = Schema.Struct({
  schemaVersion: Schema.Literal(12),
  assessmentAcceptances: Schema.optionalKey(Schema.Tuple([])),
  invocation_policies: policies,
  device_skill_selection: Schema.optionalKey(
    Schema.Union([empty, Schema.Struct({ invocation_policies: policies })]),
  ),
});
const sync = Schema.Struct({
  base_manifest: Schema.Struct({
    schema: Schema.String,
    snapshot_digests: Schema.Array(Schema.String),
  }),
});

/** Migration 014: inspect all residual data before changing any table. No live row is evidence. */
export const migrateDeclaredColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
  const residuals: Array<{
    table: string;
    column: string;
    rows: ReadonlyArray<{ rowid: number; value: JsonObject }>;
  }> = [];
  for (const { name: table } of tables) {
    for (const { name: column } of yield* sql<{ name: string }>`PRAGMA table_info(${sql(table)})`) {
      if (column !== "extra" && !column.endsWith("_extra")) continue;
      const rows: Array<{ rowid: number; value: JsonObject }> = [];
      for (const row of yield* sql<{
        rowid: number;
        value: string | null;
      }>`SELECT rowid AS rowid,${sql(column)} AS value FROM ${sql(table)}`) {
        const value =
          row.value === null
            ? {}
            : yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(row.value);
        const allowed =
          table === "library_device"
            ? [
                "schemaVersion",
                "assessmentAcceptances",
                "invocation_policies",
                "device_skill_selection",
              ]
            : table === "library_sync"
              ? ["base_manifest"]
              : table === "library_imports"
                ? ["input"]
                : table === "library_repositories"
                  ? ["invocation_policies"]
                  : table === "machine"
                    ? ["schemaVersion", "legacyMachineId"]
                    : [];
        for (const key of Object.keys(value))
          if (!allowed.includes(key)) return yield* invalid(table, key);
        const nested: ReadonlyArray<readonly [string, readonly string[]]> =
          table === "library_imports"
            ? [["input", []]]
            : table === "library_sync"
              ? [["base_manifest", ["schema", "snapshot_digests"]]]
              : table === "library_device"
                ? [
                    ["invocation_policies", []],
                    ["device_skill_selection", ["invocation_policies"]],
                    ["device_skill_selection.invocation_policies", []],
                  ]
                : table === "library_repositories"
                  ? [["invocation_policies", []]]
                  : [];
        for (const [field, names] of nested) {
          let child: unknown = value;
          for (const part of field.split(".")) {
            if (child === undefined) break;
            child = (yield* Schema.decodeUnknownEffect(JsonObject)(child))[part];
          }
          if (child !== undefined) {
            const object = yield* Schema.decodeUnknownEffect(JsonObject)(child);
            for (const key of Object.keys(object))
              if (!names.includes(key)) return yield* invalid(table, `${field}.${key}`);
          }
        }
        if (table === "library_device")
          yield* Schema.decodeUnknownEffect(device, { onExcessProperty: "error" })(value);
        else if (table === "library_sync")
          yield* Schema.decodeUnknownEffect(sync, { onExcessProperty: "error" })(value);
        else if (table === "library_imports")
          yield* Schema.decodeUnknownEffect(Schema.Struct({ input: Schema.optionalKey(empty) }), {
            onExcessProperty: "error",
          })(value);
        else if (table === "library_repositories")
          yield* Schema.decodeUnknownEffect(Schema.Struct({ invocation_policies: policies }), {
            onExcessProperty: "error",
          })(value);
        else if (table === "machine")
          yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              schemaVersion: Schema.Literal(5),
              legacyMachineId: Schema.optionalKey(Schema.Json),
            }),
            { onExcessProperty: "error" },
          )(value);
        rows.push({ rowid: row.rowid, value });
      }
      residuals.push({ table, column, rows });
    }
  }
  yield* sql`ALTER TABLE library_device ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 12 CHECK(schema_version=12)`;
  for (const column of [
    "assessment_acceptances_present",
    "invocation_policies_present",
    "device_invocation_policies_present",
  ])
    yield* sql`ALTER TABLE library_device ADD COLUMN ${sql(column)} INTEGER NOT NULL DEFAULT 0 CHECK(${sql(column)} IN (0,1))`;
  yield* sql`ALTER TABLE library_repositories ADD COLUMN invocation_policies_present INTEGER NOT NULL DEFAULT 0 CHECK(invocation_policies_present IN (0,1))`;
  yield* sql`ALTER TABLE library_sync ADD COLUMN base_schema TEXT`;
  yield* sql`ALTER TABLE library_sync ADD COLUMN snapshot_digests TEXT CHECK(snapshot_digests IS NULL OR json_valid(snapshot_digests))`;
  yield* sql`ALTER TABLE machine ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 5 CHECK(schema_version=5)`;
  yield* sql`ALTER TABLE machine ADD COLUMN legacy_machine_id_json TEXT CHECK(legacy_machine_id_json IS NULL OR json_valid(legacy_machine_id_json))`;
  yield* sql`UPDATE machine SET legacy_machine_id_json=json_quote(legacy_machine_id) WHERE legacy_machine_id IS NOT NULL`;
  for (const { table, rows } of residuals)
    for (const { rowid, value } of rows) {
      if (table === "library_device") {
        const v = yield* Schema.decodeUnknownEffect(device, { onExcessProperty: "error" })(value);
        yield* sql`UPDATE library_device SET assessment_acceptances_present=${Number(v.assessmentAcceptances !== undefined)},invocation_policies_present=${Number(v.invocation_policies !== undefined)},device_invocation_policies_present=${Number(v.device_skill_selection !== undefined && "invocation_policies" in v.device_skill_selection)} WHERE rowid=${rowid}`;
      } else if (table === "library_repositories")
        yield* sql`UPDATE library_repositories SET invocation_policies_present=${Number(value.invocation_policies !== undefined)} WHERE rowid=${rowid}`;
      else if (table === "library_sync") {
        const v = yield* Schema.decodeUnknownEffect(sync, { onExcessProperty: "error" })(value);
        yield* sql`UPDATE library_sync SET base_schema=${v.base_manifest.schema},snapshot_digests=${JSON.stringify(v.base_manifest.snapshot_digests)} WHERE rowid=${rowid}`;
      } else if (table === "machine" && Object.hasOwn(value, "legacyMachineId"))
        yield* sql`UPDATE machine SET legacy_machine_id_json=${JSON.stringify(value.legacyMachineId)} WHERE rowid=${rowid}`;
    }
  // The promoted manifest header is mandatory whenever a sync checkpoint exists.
  yield* sql`CREATE TABLE library_sync_next (
    id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,library_id TEXT NOT NULL,revision_id TEXT NOT NULL,
    base_schema TEXT NOT NULL,snapshot_digests TEXT NOT NULL CHECK(json_valid(snapshot_digests) AND json_type(snapshot_digests)='array')
  ) STRICT`;
  yield* sql`INSERT INTO library_sync_next SELECT id,origin,library_id,revision_id,base_schema,snapshot_digests FROM library_sync`;
  yield* sql`DROP TABLE library_sync`;
  yield* sql`ALTER TABLE library_sync_next RENAME TO library_sync`;
  // This CHECK references next_extra, so the checkpoint table must be rebuilt before dropping it.
  yield* sql`CREATE TABLE author_sync_checkpoints_next (
    workspace_id TEXT NOT NULL REFERENCES author_workspace_state(workspace_id),locator TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Idle','Sending','Writing')),base TEXT,
    revision TEXT,from_tree TEXT,to_tree TEXT,merged INTEGER CHECK(merged IN (0,1)),
    next_status TEXT CHECK(next_status IN ('Idle','Sending')),next_base TEXT,next_revision TEXT,
    PRIMARY KEY(workspace_id,locator),
    CHECK((status='Idle' AND revision IS NULL AND from_tree IS NULL AND to_tree IS NULL AND merged IS NULL AND next_status IS NULL AND next_base IS NULL AND next_revision IS NULL)
      OR (status='Sending' AND revision IS NOT NULL AND from_tree IS NULL AND to_tree IS NULL AND merged IS NULL AND next_status IS NULL AND next_base IS NULL AND next_revision IS NULL)
      OR (status='Writing' AND revision IS NULL AND from_tree IS NOT NULL AND to_tree IS NOT NULL AND merged IS NOT NULL AND next_status IS NOT NULL AND ((next_status='Idle' AND next_base IS NOT NULL AND next_revision IS NULL) OR (next_status='Sending' AND next_revision IS NOT NULL))))
  ) STRICT`;
  yield* sql`INSERT INTO author_sync_checkpoints_next SELECT workspace_id,locator,status,base,revision,from_tree,to_tree,merged,next_status,next_base,next_revision FROM author_sync_checkpoints`;
  yield* sql`DROP TABLE author_sync_checkpoints`;
  yield* sql`ALTER TABLE author_sync_checkpoints_next RENAME TO author_sync_checkpoints`;
  for (const { table, column } of residuals)
    if (table !== "author_sync_checkpoints" && table !== "library_sync")
      yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN ${sql(column)}`;
  yield* sql`ALTER TABLE machine DROP COLUMN legacy_machine_id`;
  const foreignKeys = yield* sql`PRAGMA foreign_key_check`;
  const integrity = yield* sql<{ integrity_check: string }>`PRAGMA integrity_check`;
  if (foreignKeys.length || integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
    return yield* invalid("database", "integrity");
});
