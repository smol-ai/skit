-- One upgrade from the dev schema (0009) to the current owner model.
-- Refuse legacy snapshots instead of discarding their files or revision pointers.
CREATE TABLE IF NOT EXISTS skit_upgrade_requires_empty_legacy_drafts (
  snapshots INTEGER NOT NULL CHECK (snapshots = 0)
);
INSERT INTO skit_upgrade_requires_empty_legacy_drafts
  SELECT (SELECT COUNT(*) FROM draft_revisions)
       + (SELECT COUNT(*) FROM draft_files)
       + (SELECT COUNT(*) FROM drafts WHERE current_revision_id IS NOT NULL);
DROP TABLE skit_upgrade_requires_empty_legacy_drafts;

DROP TABLE draft_files;
DROP TABLE draft_revisions;
ALTER TABLE drafts RENAME TO skits;
ALTER TABLE skits DROP COLUMN title;
ALTER TABLE skits DROP COLUMN description;
ALTER TABLE skits ADD COLUMN creation_request_id TEXT;

-- A tree is identified by its hash, so every Draft that records the same tree shares one row.
CREATE TABLE revision_trees (
  tree_hash TEXT PRIMARY KEY
) WITHOUT ROWID;

-- File bytes live in R2 under draft-blobs/<first 2 hex>/<hex of blob_hash>.
CREATE TABLE revision_tree_entries (
  tree_hash TEXT NOT NULL REFERENCES revision_trees(tree_hash),
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory', 'symlink')),
  mode INTEGER,
  blob_hash TEXT,
  byte_length INTEGER,
  target TEXT,
  PRIMARY KEY (tree_hash, path),
  CHECK (
    (kind = 'file' AND mode IN (420, 493) AND blob_hash IS NOT NULL AND byte_length >= 0
      AND target IS NULL)
    OR (kind = 'directory' AND mode IS NULL AND blob_hash IS NULL AND byte_length IS NULL
      AND target IS NULL)
    OR (kind = 'symlink' AND mode IS NULL AND blob_hash IS NULL AND byte_length IS NULL
      AND target IS NOT NULL)
  )
) WITHOUT ROWID;

-- author_device and author_at are asserted by the device and part of revision_id;
-- credential_id is the authenticated credential that posted the revision.
CREATE TABLE revisions (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL REFERENCES revision_trees(tree_hash),
  author_device TEXT NOT NULL,
  author_at INTEGER NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  credential_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug, revision_id),
  FOREIGN KEY (owner_slug, skit_slug) REFERENCES skits(owner_slug, skit_slug)
) WITHOUT ROWID;

CREATE INDEX idx_revisions_tree ON revisions(tree_hash);

-- A parent is always an earlier revision of the same Draft.
CREATE TABLE revision_parents (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  parent_id TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug, revision_id, position),
  FOREIGN KEY (owner_slug, skit_slug, revision_id)
    REFERENCES revisions(owner_slug, skit_slug, revision_id),
  FOREIGN KEY (owner_slug, skit_slug, parent_id)
    REFERENCES revisions(owner_slug, skit_slug, revision_id)
) WITHOUT ROWID;

CREATE INDEX idx_revision_parents_parent
  ON revision_parents(owner_slug, skit_slug, parent_id);

-- Current access is namespace ownership or current team membership.
DROP TABLE resource_grants;
-- Cloudflare bindings own rate limiting; SDK counters are obsolete.
DROP TABLE rateLimit;
-- Releases retain their revision and archive identity, not adoption metadata.
DROP INDEX idx_releases_adopted_content;
ALTER TABLE releases DROP COLUMN adopted_content_digest;
