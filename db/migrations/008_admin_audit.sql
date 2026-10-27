-- Audit trail for every administrative write and connection test.
CREATE TABLE IF NOT EXISTS admin_audit (
  id           TEXT PRIMARY KEY,                 -- aud_xxx
  actor        TEXT NOT NULL,                     -- owner | operator
  action       TEXT NOT NULL,                     -- e.g. provider.create
  target_type  TEXT,
  target_id    TEXT,
  result       TEXT NOT NULL,                     -- success | failure
  detail       TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created
  ON admin_audit (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target
  ON admin_audit (target_type, target_id);
