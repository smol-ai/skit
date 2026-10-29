-- Friction agents report with `skit feedback send`. Anonymous unless the sender opts in:
-- `principal_id` is the account whose Bearer token signed the report; `contact_email` is an
-- address the sender chose to give, never verified.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  harness TEXT,
  model TEXT,
  platform TEXT NOT NULL,
  runtime TEXT NOT NULL,
  client TEXT,
  principal_id TEXT,
  contact_email TEXT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX feedback_created_at ON feedback (created_at);
