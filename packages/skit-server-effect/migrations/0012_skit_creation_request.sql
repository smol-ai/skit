-- A matching creation request can be replayed after its response is lost.
-- Existing SKITs have no receipt and keep create-once behavior.
ALTER TABLE skits ADD COLUMN creation_request_id TEXT;
