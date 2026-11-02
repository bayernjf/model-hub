-- Provider key pool: one provider can hold multiple equivalent keys (e.g. two
-- Ark subscriptions). model-kit rotates within the pool on quota-class 429s.
-- Existing single providers.api_key_cipher rows are copied into one pool row
-- (seq=0); the legacy columns stay for one migration period (read falls back
-- to them when the pool is empty; removed in a later migration).

CREATE TABLE IF NOT EXISTS provider_keys (
  id              TEXT PRIMARY KEY,            -- pkey_xxx
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label           TEXT NOT NULL DEFAULT '',    -- e.g. "套餐A"
  api_key_cipher  TEXT NOT NULL,               -- enc$v1$kid$iv$ct
  api_key_hint    TEXT NOT NULL,               -- masked ak-****ab12
  is_active       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'ok',  -- ok | quota_exhausted
  cooled_until    TEXT,                        -- ISO; null while ok
  last_error_code TEXT,
  last_failed_at  TEXT,
  seq             INTEGER NOT NULL,            -- ascending try order, owner-sortable
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider
  ON provider_keys(provider_id, is_active, seq);

-- Per-provider cooldown policy JSON:
-- {"kind":"hours","hours":5} | {"kind":"weekly","weekday":1,"time":"00:00"}
-- | {"kind":"monthly","dayOfMonth":1,"time":"00:00"}
ALTER TABLE providers ADD COLUMN key_cooldown_policy TEXT;

-- Backfill: one pool row (seq=0, ok) per legacy non-empty provider key.
INSERT INTO provider_keys
  (id, provider_id, label, api_key_cipher, api_key_hint, is_active,
   status, cooled_until, last_error_code, last_failed_at, seq,
   created_at, updated_at)
SELECT
  'pkey_' || lower(hex(randomblob(12))),
  id,
  '',
  api_key_cipher,
  COALESCE(api_key_hint, ''),
  1,
  'ok',
  NULL,
  NULL,
  NULL,
  0,
  created_at,
  updated_at
FROM providers
WHERE api_key_cipher IS NOT NULL AND api_key_cipher <> '';
