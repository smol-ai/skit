-- Releases identify their source revision and immutable archive, not snapshot adoption.
DROP INDEX idx_releases_adopted_content;
ALTER TABLE releases DROP COLUMN adopted_content_digest;
