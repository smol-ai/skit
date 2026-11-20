import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentMachineDocument, MachineDocumentShape } from "../machine-document.js";
import { Unusable } from "../machine-settings-failures.js";

/** Machine rows are read on the same connection and transaction as the Library. */
export const loadMachineRows = Effect.fn("Library.loadMachineRows")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  const header = (yield* sql<{
    machine_id: string | null;
    legacy_machine_id_json: string | null;
    schema_version: number;
    display_name: string | null;
    repository_decisions_initialized: number;
  }>`SELECT machine_id, legacy_machine_id_json, schema_version, display_name, repository_decisions_initialized FROM machine WHERE id = 1`)[0];
  if (!header) return undefined;
  const roots = yield* sql<{
    path: string;
  }>`SELECT path FROM machine_discovery_roots ORDER BY position`;
  const repositories = yield* sql<{
    path: string;
    status: string;
  }>`SELECT path,status FROM machine_repositories ORDER BY position`;
  const document = {
    schemaVersion: header.schema_version,
    ...(header.machine_id === null ? {} : { machineId: header.machine_id }),
    ...(header.legacy_machine_id_json === null
      ? {}
      : {
          legacyMachineId: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
            header.legacy_machine_id_json,
          ).pipe(
            Effect.mapError(
              (failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } }),
            ),
          ),
        }),
    ...(header.display_name === null ? {} : { displayName: header.display_name }),
    repositoryDecisionsInitialized: header.repository_decisions_initialized === 1,
    discoveryRoots: roots.map((row) => row.path),
    repositories: repositories.map((row) => ({ path: row.path, status: row.status })),
  };
  return yield* Schema.decodeUnknownEffect(MachineDocumentShape, { onExcessProperty: "error" })(
    document,
  ).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
});

export const saveMachineRows = Effect.fn("Library.saveMachineRows")(function* (
  path: string,
  value: CurrentMachineDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Schema.decodeUnknownEffect(MachineDocumentShape, { onExcessProperty: "error" })(
    value,
  ).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
  yield* sql`INSERT INTO machine(id,machine_id,legacy_machine_id_json,schema_version,display_name,repository_decisions_initialized)
    VALUES(1,${value.machineId ?? null},${value.legacyMachineId === undefined ? null : JSON.stringify(value.legacyMachineId)},${value.schemaVersion},${value.displayName ?? null},${Number(value.repositoryDecisionsInitialized)})
    ON CONFLICT(id) DO UPDATE SET machine_id=excluded.machine_id,legacy_machine_id_json=excluded.legacy_machine_id_json,schema_version=excluded.schema_version,display_name=excluded.display_name,repository_decisions_initialized=excluded.repository_decisions_initialized`;
  yield* sql`DELETE FROM machine_discovery_roots`;
  for (const [position, path] of value.discoveryRoots.entries())
    yield* sql`INSERT INTO machine_discovery_roots (position,path) VALUES (${position},${path})`;
  yield* sql`DELETE FROM machine_repositories`;
  for (const [position, { path, status }] of value.repositories.entries())
    yield* sql`INSERT INTO machine_repositories(position,path,status) VALUES(${position},${path},${status})`;
});
