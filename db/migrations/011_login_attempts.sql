-- Persistent sliding-window login failure counters (per IP).
-- Survives restarts and lets multi-instance deployments share the same
-- brute-force budget when the DB file is shared. Only failures are stored;
-- a successful login clears the row (see login-limiter.ts).
CREATE TABLE IF NOT EXISTS login_attempts (
  ip         TEXT PRIMARY KEY,
  hits_json  TEXT NOT NULL,   -- JSON array of epoch-ms timestamps
  updated_at INTEGER NOT NULL
);
