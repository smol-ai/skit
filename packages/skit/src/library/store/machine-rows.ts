import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentMachineDocument } from "../machine-document.js";
import { Unusable } from "../machine-settings-failures.js";
import { arrayAt, isJsonObject, JsonObject } from "../../shared/json.js";

/** Machine rows are read on the same connection and transaction as the Library. */
export const loadMachineRows = Effect.fn("Library.loadMachineRows")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  const header = (yield* sql<{
    machine_id: string | null;
    legacy_machine_id: string | null;
    display_name: string | null;
    repository_decisions_initialized: number;
    extra: string | null;
  }>`SELECT machine_id, legacy_machine_id, display_name, repository_decisions_initialized, extra FROM machine WHERE id = 1`)[0];
  if (!header) return undefined;
  const extra = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
    header.extra ?? "{}",
  ).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
  const roots = yield* sql<{
    path: string;
  }>`SELECT path FROM machine_discovery_roots ORDER BY position`;
  const repositories = yield* sql<{
    path: string;
    status: string;
    extra: string;
  }>`SELECT path,status,extra FROM machine_repositories ORDER BY position`;
  const document = {
    ...extra,
    ...(header.machine_id === null ? {} : { machineId: header.machine_id }),
    ...(header.legacy_machine_id === null ? {} : { legacyMachineId: header.legacy_machine_id }),
    ...(header.display_name === null ? {} : { displayName: header.display_name }),
    repositoryDecisionsInitialized: header.repository_decisions_initialized === 1,
    discoveryRoots: roots.map((row) => row.path),
    repositories: yield* Effect.forEach(repositories, ({ path: repositoryPath, status, extra }) =>
      Schema.decodeEffect(Schema.fromJsonString(JsonObject))(extra).pipe(
        Effect.map((kept) => ({ ...kept, path: repositoryPath, status })),
        Effect.mapError(
          (failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } }),
        ),
      ),
    ),
  };
  return yield* Schema.decodeUnknownEffect(CurrentMachineDocument)(document).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
});

export const saveMachineRows = Effect.fn("Library.saveMachineRows")(function* (
  path: string,
  value: CurrentMachineDocument,
) {
  const sql = yield* SqlClient.SqlClient;
  const document = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(
    JSON.stringify(value),
  ).pipe(
    Effect.mapError((failure) => new Unusable({ path, reason: { _tag: "InvalidData", failure } })),
  );
  const extra: JsonObject = { ...document };
  for (const field of [
    "machineId",
    "displayName",
    "repositoryDecisionsInitialized",
    "discoveryRoots",
    "repositories",
  ])
    delete extra[field];
  if (typeof document.legacyMachineId === "string") delete extra.legacyMachineId;
  yield* sql`INSERT INTO machine (id,machine_id,legacy_machine_id,display_name,repository_decisions_initialized,extra) VALUES (1,${value.machineId ?? null},${typeof document.legacyMachineId === "string" ? document.legacyMachineId : null},${value.displayName ?? null},${value.repositoryDecisionsInitialized ? 1 : 0},${JSON.stringify(extra)}) ON CONFLICT(id) DO UPDATE SET machine_id=excluded.machine_id,legacy_machine_id=excluded.legacy_machine_id,display_name=excluded.display_name,repository_decisions_initialized=excluded.repository_decisions_initialized,extra=excluded.extra`;
  yield* sql`DELETE FROM machine_discovery_roots`;
  for (const [position, path] of value.discoveryRoots.entries())
    yield* sql`INSERT INTO machine_discovery_roots (position,path) VALUES (${position},${path})`;
  yield* sql`DELETE FROM machine_repositories`;
  const repositoryDocuments = arrayAt(document, "repositories");
  for (const [position, { path, status }] of value.repositories.entries()) {
    const row = repositoryDocuments[position];
    const { path: _path, status: _status, ...extra } = isJsonObject(row) ? row : {};
    yield* sql`INSERT INTO machine_repositories (position,path,status,extra) VALUES (${position},${path},${status},${JSON.stringify(extra)})`;
  }
});
