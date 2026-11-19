import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** The loader owns the single unreleased database format. */
export const createLibraryTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`CREATE TABLE library_collections (
  collection_id TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  upstream      TEXT CHECK (upstream IS NULL OR json_valid(upstream)),
  extra         TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_skills (
  skill_id         TEXT PRIMARY KEY,
  collection_id    TEXT NOT NULL REFERENCES library_collections (collection_id),
  path             TEXT NOT NULL,
  name             TEXT NOT NULL,
  local_version_id TEXT,
  extra            TEXT,
  UNIQUE (collection_id, path)
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_skill_versions (
  skill_version_id         TEXT PRIMARY KEY,
  skill_id                 TEXT NOT NULL REFERENCES library_skills (skill_id),
  source_hash              TEXT NOT NULL,
  artifact_hash            TEXT NOT NULL,
  validation_identity_hash TEXT NOT NULL,
  skill_format              TEXT NOT NULL,
  extra                    TEXT
) STRICT`);
  yield* sql.unsafe(
    `CREATE INDEX library_skill_versions_skill ON library_skill_versions (skill_id)`,
  );
  yield* sql.unsafe(`CREATE TABLE library_collection_versions (
  collection_version_id TEXT PRIMARY KEY,
  hash                  TEXT NOT NULL,
  copy_profile          TEXT NOT NULL,
  extra                 TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_collection_version_members (
  collection_version_id   TEXT NOT NULL REFERENCES library_collection_versions (collection_version_id),
  source_path             TEXT NOT NULL,
  source_hash             TEXT NOT NULL,
  artifact_hash           TEXT NOT NULL,
  skill_format             TEXT NOT NULL,
  extra                   TEXT,
  PRIMARY KEY (collection_version_id, source_path)
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_imports (
  import_id             TEXT PRIMARY KEY,
  collection_id         TEXT NOT NULL REFERENCES library_collections (collection_id),
  kind                  TEXT NOT NULL CHECK (kind IN ('source', 'edit')),
  collection_version_id TEXT NOT NULL REFERENCES library_collection_versions (collection_version_id),
  source_identity       TEXT NOT NULL CHECK (json_valid(source_identity)),
  input                 TEXT NOT NULL,
  revision              TEXT,
  imported_at           TEXT NOT NULL,
  machine_id            TEXT NOT NULL,
  lock_file_entries     TEXT NOT NULL CHECK (json_valid(lock_file_entries)),
  extra                 TEXT
) STRICT`);
  yield* sql.unsafe(
    `CREATE INDEX library_imports_collection ON library_imports (collection_id, kind, imported_at DESC, import_id DESC)`,
  );
  yield* sql.unsafe(`CREATE TABLE library_enabled (
  scope         TEXT NOT NULL CHECK (scope IN ('account', 'device', 'repository')),
  root          TEXT NOT NULL DEFAULT '' CHECK ((scope = 'repository') = (root <> '')),
  item_key      TEXT NOT NULL,
  collection_id TEXT,
  skill_id      TEXT,
  extra         TEXT,
  PRIMARY KEY (scope, root, item_key)
) STRICT`);
  yield* sql.unsafe(`CREATE INDEX library_enabled_scope ON library_enabled (scope, root)`);
  yield* sql.unsafe(`CREATE TABLE library_invocation_policies (
  scope    TEXT NOT NULL CHECK (scope IN ('account', 'device', 'repository')),
  root     TEXT NOT NULL DEFAULT '' CHECK ((scope = 'repository') = (root <> '')),
  skill_id TEXT NOT NULL,
  policy   TEXT NOT NULL,
  PRIMARY KEY (scope, root, skill_id)
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_repositories (
  root  TEXT PRIMARY KEY,
  extra TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_installed_skills (
  installed_skill_id TEXT PRIMARY KEY,
  skill_id           TEXT NOT NULL,
  skill_version_id   TEXT NOT NULL,
  destination        TEXT NOT NULL,
  root               TEXT NOT NULL,
  path               TEXT NOT NULL UNIQUE,
  expected_hash      TEXT NOT NULL,
  installed_at       TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('installed', 'pending', 'conflicted', 'suppressed')),
  current_hash       TEXT,
  conflicts          TEXT CHECK (conflicts IS NULL OR json_valid(conflicts)),
  suppression_reason TEXT,
  suppressed_at      TEXT,
  extra              TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_assessment_acceptances (
  fingerprint           TEXT NOT NULL,
  artifact_content_hash TEXT NOT NULL,
  skill_version_id      TEXT NOT NULL,
  context               TEXT NOT NULL,
  principal             TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  accepted_at           TEXT NOT NULL,
  expires_at            TEXT,
  extra                 TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_inventory (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  unmanaged        TEXT CHECK (unmanaged IS NULL OR json_valid(unmanaged)),
  ownership_issues TEXT CHECK (ownership_issues IS NULL OR json_valid(ownership_issues)),
  scan_issues      TEXT CHECK (scan_issues IS NULL OR json_valid(scan_issues))
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_device (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  device_skill_selection          TEXT CHECK (device_skill_selection IN ('follow-account', 'choose')),
  pending_device_selection_origin TEXT,
  state_hash                      TEXT NOT NULL,
  extra                           TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_sync (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  origin      TEXT NOT NULL,
  library_id  TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  extra       TEXT
) STRICT`);
  yield* sql.unsafe(`CREATE TABLE library_sync_base (
  entity TEXT NOT NULL,
  key    TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  value  TEXT CHECK (value IS NULL OR json_valid(value)),
  CHECK ((change = 'added') = (value IS NULL)),
  PRIMARY KEY (entity, key)
) STRICT`);
});
