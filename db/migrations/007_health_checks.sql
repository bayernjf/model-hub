-- Project-reported L3/L4 connection test results.
CREATE TABLE IF NOT EXISTS health_checks (
  id             TEXT PRIMARY KEY,               -- hc_xxx
  project_id     TEXT NOT NULL,
  assignment_id  TEXT,
  alias          TEXT,
  level          TEXT NOT NULL,                  -- L3 | L4
  ok             INTEGER NOT NULL,
  latency_ms     INTEGER NOT NULL,
  error_code     TEXT,
  error_detail   TEXT,
  error_hint     TEXT,
  ts             TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_project
  ON health_checks (project_id, ts);
CREATE INDEX IF NOT EXISTS idx_health_assignment
  ON health_checks (assignment_id, ts);
