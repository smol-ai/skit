PRAGMA foreign_keys = ON;

CREATE TABLE releases (
  owner_slug TEXT NOT NULL,
  skit_slug TEXT NOT NULL,
  version TEXT NOT NULL,
  release_id TEXT NOT NULL UNIQUE,
  source_revision TEXT,
  archive_digest TEXT NOT NULL,
  archive_bytes INTEGER NOT NULL,
  archive_object_key TEXT NOT NULL UNIQUE,
  published_at TEXT NOT NULL,
  PRIMARY KEY (owner_slug, skit_slug, version)
);

CREATE INDEX idx_releases_latest
  ON releases(owner_slug, skit_slug, published_at DESC);
