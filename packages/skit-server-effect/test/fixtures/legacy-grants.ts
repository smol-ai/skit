/** A worker can be upgraded before its database; legacy rows must still convey no access. */
export const legacyGrantsTable = `CREATE TABLE IF NOT EXISTS resource_grants (
  grant_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'team')),
  subject_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('namespace', 'skit', 'library', 'release')),
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'change', 'advance', 'publish', 'admin')),
  created_at TEXT NOT NULL,
  UNIQUE(subject_kind, subject_id, resource_kind, resource_id, permission)
)`;
