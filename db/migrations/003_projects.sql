-- Registered projects that pull assigned models. Project tokens live in
-- the separate tokens table (a project may hold several valid tokens during
-- rotation).
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,              -- prj_xxx
  slug          TEXT NOT NULL UNIQUE,          -- e.g. zeus / job-agent
  display_name  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
