-- Existing server revisions are disposable development data. Their original hashes did not
-- cover per-path edit times, so no truthful edits_json value can be backfilled. Reset the
-- revision graph instead of inventing times or changing the already-applied 0010 migration.
-- Keep SKITs, Releases and Library data; clear references to the discarded author revisions.
UPDATE skits SET current_revision_id = NULL;
UPDATE releases SET source_revision = NULL;
DELETE FROM revision_parents;
DROP TABLE revisions;
DELETE FROM revision_tree_entries;
DELETE FROM revision_trees;

-- R2 draft-blobs objects and published release archives are intentionally left untouched.
CREATE TABLE revisions (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL REFERENCES revision_trees(tree_hash),
  author_device TEXT NOT NULL,
  author_at INTEGER NOT NULL,
  edits_json TEXT NOT NULL CHECK (json_valid(edits_json)),
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  credential_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug, revision_id),
  FOREIGN KEY (owner_slug, skit_slug) REFERENCES skits(owner_slug, skit_slug)
) WITHOUT ROWID;

CREATE INDEX idx_revisions_tree ON revisions(tree_hash);
