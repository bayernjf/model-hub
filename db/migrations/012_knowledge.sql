-- Knowledge base (PRD F3 / M3). Documents are uploaded per owner, where the
-- owner is a project id from the existing tokens auth surface, so owner
-- isolation reuses the project/token boundary. Each document is split into
-- chunks whose embedding vectors are stored as JSON arrays of floats; the
-- MVP retrieval is a brute-force in-memory cosine scan over one owner's
-- chunks, so no vector extension or index is used.
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,            -- doc_xxx
  owner       TEXT NOT NULL,               -- project id (owner isolation)
  title       TEXT NOT NULL,
  source      TEXT,                        -- e.g. console | api | file name
  mime        TEXT,                        -- text/plain | text/markdown
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_owner
  ON documents (owner, created_at);

-- Chunks belong to one document; owner isolation on read goes through the
-- documents join, so owner is not denormalized here.
CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,           -- chk_xxx
  doc_id       TEXT NOT NULL,
  position     INTEGER NOT NULL,           -- 0-based order within the doc
  content      TEXT NOT NULL,
  embedding    TEXT,                       -- JSON array of floats
  token_count  INTEGER,                    -- rough estimate, informational
  created_at   TEXT NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents (id)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc
  ON chunks (doc_id, position);
