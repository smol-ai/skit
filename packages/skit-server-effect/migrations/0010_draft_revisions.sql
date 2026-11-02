-- A Draft is a graph of content-addressed revisions and one `current` pointer (ADR-0027).
-- Nobody has used Drafts yet, so the old snapshot rows are dropped rather than converted.
DROP TABLE draft_files;
DROP TABLE draft_revisions;
UPDATE drafts SET current_revision_id = NULL;
ALTER TABLE drafts DROP COLUMN title;
ALTER TABLE drafts DROP COLUMN description;

-- A tree is identified by its hash, so every Draft that records the same tree shares one row.
CREATE TABLE draft_trees (
  tree_hash TEXT PRIMARY KEY
) WITHOUT ROWID;

-- File bytes live in R2 under draft-blobs/<first 2 hex>/<hex of blob_hash>.
CREATE TABLE draft_tree_entries (
  tree_hash TEXT NOT NULL REFERENCES draft_trees(tree_hash),
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
CREATE TABLE draft_revisions (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL REFERENCES draft_trees(tree_hash),
  author_device TEXT NOT NULL,
  author_at INTEGER NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  credential_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug, revision_id),
  FOREIGN KEY (owner_slug, skit_slug) REFERENCES drafts(owner_slug, skit_slug)
) WITHOUT ROWID;

CREATE INDEX idx_draft_revisions_tree ON draft_revisions(tree_hash);

-- A parent is always an earlier revision of the same Draft.
CREATE TABLE draft_revision_parents (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  parent_id TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug, revision_id, position),
  FOREIGN KEY (owner_slug, skit_slug, revision_id)
    REFERENCES draft_revisions(owner_slug, skit_slug, revision_id),
  FOREIGN KEY (owner_slug, skit_slug, parent_id)
    REFERENCES draft_revisions(owner_slug, skit_slug, revision_id)
) WITHOUT ROWID;

CREATE INDEX idx_draft_revision_parents_parent
  ON draft_revision_parents(owner_slug, skit_slug, parent_id);
