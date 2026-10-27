-- Many-to-many assignment of models to projects. The second unique
-- constraint enforces an alias unique within a project; SQLite treats NULLs
-- as distinct, so multiple alias-less rows are allowed as intended.
CREATE TABLE IF NOT EXISTS assignments (
  id                   TEXT PRIMARY KEY,       -- asn_xxx
  project_id           TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'primary', -- primary | fallback
  alias                TEXT,                            -- project-unique alias
  daily_budget_micros  INTEGER,                         -- owner-only daily budget
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (project_id, model_id),
  UNIQUE (project_id, alias),
  FOREIGN KEY (project_id) REFERENCES projects (id),
  FOREIGN KEY (model_id) REFERENCES model_overlays (id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_project
  ON assignments (project_id);
CREATE INDEX IF NOT EXISTS idx_assignments_model
  ON assignments (model_id);
