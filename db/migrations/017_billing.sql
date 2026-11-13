-- Frozen billing statements (T-B1-04). One row per project per UTC month
-- snapshots the project's billable amount, so an invoice can be issued from a
-- stable row independent of later usage rows. byok usage never appears here:
-- it is metered, not billed (its cost_micros is the customer's own key spend).
--
-- UNIQUE(project_id, period) is the idempotency key: re-freezing the same
-- month updates the row in place instead of creating a duplicate.

CREATE TABLE IF NOT EXISTS billing_periods (
  id            TEXT PRIMARY KEY,      -- blp_xxx
  project_id    TEXT NOT NULL,
  period        TEXT NOT NULL,         -- YYYY-MM (UTC calendar month)
  amount_micros INTEGER NOT NULL,      -- builtin billable amount; byok excluded
  status        TEXT NOT NULL DEFAULT 'frozen',  -- frozen | void
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, period),
  FOREIGN KEY (project_id) REFERENCES projects (id)
);

CREATE INDEX IF NOT EXISTS idx_billing_periods_period
  ON billing_periods (period);
