-- Provider credentials. A provider is one credential set against one vendor
-- base URL; the same vendor may have multiple provider rows (e.g. Plan vs
-- pay-as-you-go, or multiple keys).
CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,            -- prov_xxx
  name            TEXT NOT NULL,
  preset_id       TEXT,                        -- ark-plan / ark / agnes / ...
  protocol        TEXT NOT NULL,               -- openai-compatible | anthropic | gemini
  base_url        TEXT NOT NULL,               -- API root, no endpoint path
  billing_type    TEXT NOT NULL DEFAULT 'payg',-- payg | subscription
  api_key_cipher  TEXT,                        -- enc$v1$kid$iv$ct
  api_key_hint    TEXT,                        -- masked, e.g. ak-****ab12
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
