-- Friction agents report with `skit feedback send`. Anonymous: no principal is recorded.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  harness TEXT,
  model TEXT,
  platform TEXT NOT NULL,
  runtime TEXT NOT NULL,
  client TEXT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX feedback_created_at ON feedback (created_at);
