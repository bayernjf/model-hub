-- Cost governance (PRD F6 / M5).
--
-- 1. usage_events.degraded marks calls that the project-side kit rerouted to
--    a fallback assignment after the requested primary crossed its daily
--    budget, so degraded spend stays attributable in the cost ledger
--    (FR6-2). Rows reported by older kit builds default to 0.
-- 2. budget_alerts records fire-once watermark alerts (80% / 100% of an
--    assignment's daily budget, FR6-3). The unique index makes alerting
--    idempotent per (project, assignment, UTC day, level): repeated usage
--    reports after the crossing never double-notify, and the table doubles
--    as a durable alert audit trail.
ALTER TABLE usage_events ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS budget_alerts (
  id            TEXT PRIMARY KEY,          -- bal_xxx
  project_id    TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  day           TEXT NOT NULL,             -- UTC YYYY-MM-DD
  level         TEXT NOT NULL,             -- '80' | '100'
  spent_micros  INTEGER NOT NULL,
  budget_micros INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alerts_once
  ON budget_alerts (project_id, assignment_id, day, level);
