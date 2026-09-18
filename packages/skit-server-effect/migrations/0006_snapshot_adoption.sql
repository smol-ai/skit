ALTER TABLE releases ADD COLUMN adopted_content_digest TEXT;

CREATE UNIQUE INDEX idx_releases_adopted_content
  ON releases(owner_slug, skit_slug, adopted_content_digest)
  WHERE adopted_content_digest IS NOT NULL;
