CREATE TABLE library_snapshots (
  library_id TEXT NOT NULL REFERENCES libraries(library_id),
  snapshot_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready')),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  PRIMARY KEY (library_id, snapshot_digest)
);
