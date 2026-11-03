-- Persist L2 model connection-test outcomes so the models page can show the
-- last result after a reload instead of a session-only "untested" badge.
-- Append-only history; the models list reads the newest row per model via
-- MAX(rowid). FK mirrors assignments.model_id -> model_overlays(id).

CREATE TABLE IF NOT EXISTS model_test_results (
  id         TEXT PRIMARY KEY,       -- mtr_xxx
  model_id   TEXT NOT NULL,
  deep       INTEGER NOT NULL,       -- 1 = paid deep test
  ok         INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error_code TEXT,
  tested_at  TEXT NOT NULL,
  FOREIGN KEY (model_id) REFERENCES model_overlays (id)
);

CREATE INDEX IF NOT EXISTS idx_model_test_results_model
  ON model_test_results (model_id);
