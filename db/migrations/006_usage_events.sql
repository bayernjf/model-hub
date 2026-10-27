-- Append-only usage events reported by projects. Raw units only; the hub
-- computes cost_micros from the prices issued at pull time. No prompt
-- content is ever stored.
CREATE TABLE IF NOT EXISTS usage_events (
  id                 TEXT PRIMARY KEY,          -- use_xxx
  project_id         TEXT NOT NULL,
  feature            TEXT NOT NULL,
  billing_source     TEXT NOT NULL,              -- builtin | byok
  billing_type       TEXT,                       -- payg | subscription snapshot
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  assignment_id      TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER,
  quantity           REAL,
  http_status        INTEGER NOT NULL,
  cached             INTEGER NOT NULL DEFAULT 0,
  cost_micros        INTEGER,
  ts                 TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_project_ts
  ON usage_events (project_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_assignment
  ON usage_events (assignment_id);
CREATE INDEX IF NOT EXISTS idx_usage_model_ts
  ON usage_events (model, ts);
