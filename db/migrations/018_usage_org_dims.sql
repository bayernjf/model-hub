-- Tier0 org M3 F3.1: model usage attributed to org positions / departments /
-- tasks. All three columns are nullable: reports sent without org context
-- (every caller before this batch) keep NULL, so the existing project × day ×
-- model aggregations are unchanged and old rows stay valid.
ALTER TABLE usage_events ADD COLUMN position_id TEXT;
ALTER TABLE usage_events ADD COLUMN department_id TEXT;
ALTER TABLE usage_events ADD COLUMN task_id TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_task
  ON usage_events (task_id);
CREATE INDEX IF NOT EXISTS idx_usage_position_ts
  ON usage_events (position_id, ts);
