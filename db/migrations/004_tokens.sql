-- Project tokens. Only the SHA-256 hash is stored; the plaintext is shown
-- once on creation/rotation. Multiple enabled tokens per project support
-- seamless rotation.
CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT PRIMARY KEY,              -- tok_xxx
  project_id    TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                  -- SHA-256 hex
  token_hint    TEXT,                           -- masked, e.g. mh-****ab12
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  UNIQUE (project_id, token_hash),
  FOREIGN KEY (project_id) REFERENCES projects (id)
);

CREATE INDEX IF NOT EXISTS idx_tokens_project
  ON tokens (project_id);
CREATE INDEX IF NOT EXISTS idx_tokens_hash
  ON tokens (token_hash);
