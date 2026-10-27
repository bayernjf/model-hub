-- Model instances imported from the preset catalog or entered manually.
-- Imported rows copy the preset defaults; the owner-overlay fields
-- (modalities, pricing, enabled, is_default, sort_order) are editable via
-- the strict whitelist. Named model_overlays because the table stores both
-- the model instance and its overlay. Credential/dialect fields live on the
-- provider and are never writable here.
CREATE TABLE IF NOT EXISTS model_overlays (
  id                 TEXT PRIMARY KEY,         -- mdl_xxx
  provider_id        TEXT NOT NULL,
  preset_model_id    TEXT,
  model              TEXT NOT NULL,            -- model ID sent to the API
  display_name       TEXT,
  modalities         TEXT NOT NULL DEFAULT '[]', -- JSON array of modalities
  litellm_id         TEXT,                     -- e.g. openai/model for Python
  context_window     INTEGER,
  supports_json      INTEGER NOT NULL DEFAULT 0,
  supports_stream    INTEGER NOT NULL DEFAULT 0,
  pricing            TEXT,                     -- JSON multi-dimensional pricing
  endpoints_override TEXT,                     -- JSON overrides
  adapter            TEXT,                     -- JSON dialect description
  is_default         INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (provider_id, model),
  FOREIGN KEY (provider_id) REFERENCES providers (id)
);

CREATE INDEX IF NOT EXISTS idx_model_overlays_provider
  ON model_overlays (provider_id);
