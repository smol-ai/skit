ALTER TABLE user ADD COLUMN username TEXT
  CHECK (username IS NULL OR (username = lower(username) AND length(username) BETWEEN 1 AND 64));

CREATE UNIQUE INDEX idx_user_username ON user(username) WHERE username IS NOT NULL;
