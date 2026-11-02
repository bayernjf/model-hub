-- One model may now serve a project under several distinct aliases (e.g. a
-- single subscription model backing the noul/choice/score decision roles).
-- SQLite cannot drop a single table constraint, so rebuild the table without
-- UNIQUE(project_id, model_id); UNIQUE(project_id, alias) is retained, and
-- alias-less duplicates of the same model stay rejected at the application
-- layer. Existing rows are unique per (project_id, model_id) by the old
-- constraint, so the copy cannot collide.

CREATE TABLE assignments_new (
  id                   TEXT PRIMARY KEY,       -- asn_xxx
  project_id           TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'primary', -- primary | fallback
  alias                TEXT,                            -- project-unique alias
  daily_budget_micros  INTEGER,                         -- owner-only daily budget
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (project_id, alias),
  FOREIGN KEY (project_id) REFERENCES projects (id),
  FOREIGN KEY (model_id) REFERENCES model_overlays (id)
);

INSERT INTO assignments_new
  (id, project_id, model_id, role, alias, daily_budget_micros,
   created_at, updated_at)
SELECT id, project_id, model_id, role, alias, daily_budget_micros,
       created_at, updated_at
FROM assignments;

DROP TABLE assignments;
ALTER TABLE assignments_new RENAME TO assignments;

CREATE INDEX IF NOT EXISTS idx_assignments_project
  ON assignments (project_id);
CREATE INDEX IF NOT EXISTS idx_assignments_model
  ON assignments (model_id);
