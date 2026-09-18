CREATE TABLE drafts (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug)
);

CREATE TABLE draft_revisions (
  revision_id TEXT PRIMARY KEY,
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  parent_revision_id TEXT,
  bundle_digest TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_slug, skit_slug) REFERENCES drafts(owner_slug, skit_slug)
);

CREATE TABLE draft_files (
  revision_id TEXT NOT NULL REFERENCES draft_revisions(revision_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  object_key TEXT NOT NULL,
  PRIMARY KEY (revision_id, path)
) WITHOUT ROWID;

CREATE INDEX idx_draft_revisions_resource
  ON draft_revisions(owner_slug, skit_slug, created_at DESC);
