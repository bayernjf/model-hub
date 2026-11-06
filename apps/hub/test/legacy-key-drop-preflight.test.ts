import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/open.js';
import { migrateUp } from '../src/db/migrate.js';

/**
 * End-to-end coverage for scripts/check-legacy-key-drop-preflight.mjs.
 * Drives the real CLI against real SQLite files in a temp dir (no mocks):
 * an un-migrated DB and a migrated DB whose key pool covers every provider.
 */

const SCRIPT = join(__dirname, '../../../scripts/check-legacy-key-drop-preflight.mjs');

function runPreflight(dbPath: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--experimental-sqlite', SCRIPT, '--db', dbPath],
      { encoding: 'utf8' },
    );
    return { status: 0, stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? e.stderr ?? '' };
  }
}

function seedProviderWithLegacyKey(dbPath: string): void {
  const db = openDatabase(dbPath);
  db.exec(
    `INSERT INTO providers
       (id, name, protocol, base_url, api_key_cipher, api_key_hint, enabled, created_at, updated_at)
     VALUES
       ('prov_seed','Seed','openai-compatible','https://x/v1','enc\$legacy','****legacy',1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`,
  );
  db.close();
}

describe('legacy-key-drop preflight CLI', () => {
  it('fails when migration 014 (provider_keys) has not been applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-legacypre-'));
    try {
      const dbPath = join(dir, 'model-hub.db');
      // A bare providers table without provider_keys (pre-014 shape).
      const db = openDatabase(dbPath);
      db.exec(
        `CREATE TABLE providers (
           id TEXT PRIMARY KEY, name TEXT, protocol TEXT, base_url TEXT,
           api_key_cipher TEXT, api_key_hint TEXT, enabled INTEGER,
           created_at TEXT, updated_at TEXT)`,
      );
      db.close();
      seedProviderWithLegacyKey(dbPath);

      const { status, stdout } = runPreflight(dbPath);
      expect(status).toBe(1);
      expect(stdout).toContain('provider_keys missing');
      expect(stdout).toContain('RESULT: FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when every legacy-key provider has a usable key-pool row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-legacypre-'));
    try {
      const dbPath = join(dir, 'model-hub.db');
      const db = openDatabase(dbPath);
      migrateUp(db); // applies 001..016 including provider_keys
      db.exec(
        `INSERT INTO providers
           (id, name, protocol, base_url, api_key_cipher, api_key_hint, enabled, created_at, updated_at)
         VALUES
           ('prov_ok','OK','openai-compatible','https://x/v1','enc\$legacy','****legacy',1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`,
      );
      db.exec(
        `INSERT INTO provider_keys
           (id, provider_id, label, api_key_cipher, api_key_hint, is_active,
            status, cooled_until, last_error_code, last_failed_at, seq, created_at, updated_at)
         VALUES
           ('pkey_ok','prov_ok','plan-A','enc\$pool','****pool',1,'ok',NULL,NULL,NULL,0,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`,
      );
      db.close();

      const { status, stdout } = runPreflight(dbPath);
      expect(status).toBe(0);
      expect(stdout).toContain('all covered');
      expect(stdout).toContain('RESULT: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a legacy-key provider has no usable pool row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-legacypre-'));
    try {
      const dbPath = join(dir, 'model-hub.db');
      const db = openDatabase(dbPath);
      migrateUp(db);
      db.exec(
        `INSERT INTO providers
           (id, name, protocol, base_url, api_key_cipher, api_key_hint, enabled, created_at, updated_at)
         VALUES
           ('prov_stranded','Stranded','openai-compatible','https://x/v1','enc\$legacy','****legacy',1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`,
      );
      // No provider_keys row on purpose.
      db.close();

      const { status, stdout } = runPreflight(dbPath);
      expect(status).toBe(1);
      expect(stdout).toContain('no usable pool row');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
