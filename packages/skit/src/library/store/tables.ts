import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** The loader owns the single unreleased database format. */
export const createLibraryTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE library_collections (
  collection_id TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  upstream      TEXT CHECK (upstream IS NULL OR json_valid(upstream))) STRICT`;
  yield* sql`CREATE TABLE library_skills (
  skill_id         TEXT PRIMARY KEY,
  collection_id    TEXT NOT NULL REFERENCES library_collections (collection_id),
  path             TEXT NOT NULL,
  name             TEXT NOT NULL,
  local_version_id TEXT,
  UNIQUE (collection_id, path)
) STRICT`;
  yield* sql`CREATE TABLE library_skill_versions (
  skill_version_id         TEXT PRIMARY KEY,
  skill_id                 TEXT NOT NULL REFERENCES library_skills (skill_id),
  source_hash              TEXT NOT NULL,
  artifact_hash            TEXT NOT NULL,
  validation_identity_hash TEXT NOT NULL,
  skill_format              TEXT NOT NULL) STRICT`;
  yield* sql`CREATE TABLE library_collection_versions (
  collection_version_id TEXT PRIMARY KEY,
  hash                  TEXT NOT NULL,
  copy_profile          TEXT NOT NULL) STRICT`;
  yield* sql`CREATE TABLE library_collection_version_members (
  collection_version_id   TEXT NOT NULL REFERENCES library_collection_versions (collection_version_id),
  source_path             TEXT NOT NULL,
  source_hash             TEXT NOT NULL,
  artifact_hash           TEXT NOT NULL,
  skill_format             TEXT NOT NULL,
  PRIMARY KEY (collection_version_id, source_path)
) STRICT`;
  yield* sql`CREATE TABLE library_imports (
  import_id             TEXT PRIMARY KEY,
  collection_id         TEXT NOT NULL REFERENCES library_collections (collection_id),
  kind                  TEXT NOT NULL CHECK (kind IN ('source', 'edit')),
  collection_version_id TEXT NOT NULL REFERENCES library_collection_versions (collection_version_id),
  source_identity       TEXT NOT NULL CHECK (json_valid(source_identity)),
  input                 TEXT NOT NULL,
  revision              TEXT,
  imported_at           TEXT NOT NULL,
  machine_id            TEXT NOT NULL,
  lock_file_entries     TEXT NOT NULL CHECK (json_valid(lock_file_entries))) STRICT`;
  yield* sql`CREATE TABLE library_enabled (
  scope         TEXT NOT NULL CHECK (scope IN ('account', 'device', 'repository')),
  root          TEXT NOT NULL DEFAULT '' CHECK ((scope = 'repository') = (root <> '')),
  item_key      TEXT NOT NULL,
  collection_id TEXT,
  skill_id      TEXT,
  PRIMARY KEY (scope, root, item_key)
) STRICT`;
  yield* sql`CREATE TABLE library_invocation_policies (
  scope    TEXT NOT NULL CHECK (scope IN ('account', 'device', 'repository')),
  root     TEXT NOT NULL DEFAULT '' CHECK ((scope = 'repository') = (root <> '')),
  skill_id TEXT NOT NULL,
  policy   TEXT NOT NULL,
  PRIMARY KEY (scope, root, skill_id)
) STRICT`;
  yield* sql`CREATE TABLE library_repositories (
  root  TEXT PRIMARY KEY,
  invocation_policies_present INTEGER NOT NULL DEFAULT 0 CHECK(invocation_policies_present IN (0,1))) STRICT`;
  yield* sql`CREATE TABLE "library_installed_skills" (
    installed_skill_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,skill_version_id TEXT NOT NULL,
    destination TEXT NOT NULL,root TEXT NOT NULL,path TEXT NOT NULL UNIQUE,
    expected_hash TEXT NOT NULL,installed_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('installed','pending','conflicted','suppressed')),
    current_hash TEXT,conflicts TEXT CHECK(conflicts IS NULL OR json_valid(conflicts)),
    suppression_reason TEXT,suppressed_at TEXT,
    FOREIGN KEY(skill_id,skill_version_id) REFERENCES library_skill_versions(skill_id,skill_version_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`;
  yield* sql`CREATE TABLE library_assessment_acceptances (
  fingerprint           TEXT NOT NULL,
  artifact_content_hash TEXT NOT NULL,
  skill_version_id      TEXT NOT NULL,
  context               TEXT NOT NULL,
  principal             TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  accepted_at           TEXT NOT NULL,
  expires_at            TEXT) STRICT`;
  yield* sql`CREATE TABLE library_device (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  device_skill_selection          TEXT CHECK (device_skill_selection IN ('follow-account', 'choose')),
  pending_device_selection_origin TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0 AND revision < 9007199254740991), schema_version INTEGER NOT NULL DEFAULT 12 CHECK(schema_version=12), "assessment_acceptances_present" INTEGER NOT NULL DEFAULT 0 CHECK("assessment_acceptances_present" IN (0,1)), "invocation_policies_present" INTEGER NOT NULL DEFAULT 0 CHECK("invocation_policies_present" IN (0,1)), "device_invocation_policies_present" INTEGER NOT NULL DEFAULT 0 CHECK("device_invocation_policies_present" IN (0,1))) STRICT`;
  yield* sql`CREATE TABLE "library_sync" (
    id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,library_id TEXT NOT NULL,revision_id TEXT NOT NULL,
    base_schema TEXT NOT NULL,snapshot_digests TEXT NOT NULL CHECK(json_valid(snapshot_digests) AND json_type(snapshot_digests)='array')
  ) STRICT`;
  yield* sql`CREATE TABLE library_sync_base (
  entity TEXT NOT NULL,
  key    TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  value  TEXT CHECK (value IS NULL OR json_valid(value)),
  CHECK ((change = 'added') = (value IS NULL)),
  PRIMARY KEY (entity, key)
) STRICT`;
  yield* sql`CREATE TABLE library_operations (position INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, kind TEXT, document TEXT NOT NULL)`;
  yield* sql`CREATE TABLE library_audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,document TEXT NOT NULL,operation_ids TEXT NOT NULL DEFAULT '[]')`;
  yield* sql`CREATE TABLE library_import (source TEXT PRIMARY KEY, backup TEXT, hash TEXT, fenced INTEGER NOT NULL CHECK(fenced IN (0,1))) STRICT`;
  yield* sql`CREATE INDEX library_skill_versions_skill ON library_skill_versions (skill_id)`;
  yield* sql`CREATE UNIQUE INDEX library_skill_version_owners ON library_skill_versions(skill_id,skill_version_id)`;
  yield* sql`CREATE INDEX library_imports_collection ON library_imports (collection_id, kind, imported_at DESC, import_id DESC)`;
  yield* sql`CREATE INDEX library_enabled_scope ON library_enabled (scope, root)`;
});

export const createMachineTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE machine (id INTEGER PRIMARY KEY CHECK(id = 1),machine_id TEXT,display_name TEXT,repository_decisions_initialized INTEGER NOT NULL CHECK(repository_decisions_initialized IN (0,1)),schema_version INTEGER NOT NULL DEFAULT 5 CHECK(schema_version=5), legacy_machine_id_json TEXT CHECK(legacy_machine_id_json IS NULL OR json_valid(legacy_machine_id_json))) STRICT`;
  yield* sql`CREATE TABLE machine_discovery_roots (position INTEGER PRIMARY KEY CHECK(position >= 0),path TEXT NOT NULL) STRICT`;
  yield* sql`CREATE TABLE machine_repositories (position INTEGER PRIMARY KEY CHECK(position >= 0),path TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('watched','ignored'))) STRICT`;
});
