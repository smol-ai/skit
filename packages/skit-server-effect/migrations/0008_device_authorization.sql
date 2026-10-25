-- Better Auth device authorization (RFC 8628) for `skit auth login`.
CREATE TABLE deviceCode (
  id TEXT PRIMARY KEY,
  deviceCode TEXT NOT NULL UNIQUE,
  userCode TEXT NOT NULL UNIQUE,
  userId TEXT REFERENCES user(id) ON DELETE CASCADE,
  expiresAt INTEGER NOT NULL,
  status TEXT NOT NULL,
  lastPolledAt INTEGER,
  pollingInterval INTEGER,
  clientId TEXT,
  scope TEXT
);
