import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getMigrationsDir,
  MigrationReplayError,
  migrateUp,
  migrationStatus,
} from '../src/db/migrate.js';
import { openDatabase } from '../src/db/open.js';
import type { DatabaseSync } from 'node:sqlite';

const EXPECTED_TABLES = [
  'providers',
  'model_overlays',
  'projects',
  'tokens',
  'assignments',
  'usage_events',
  'health_checks',
  'admin_audit',
  'meta',
  'login_attempts',
  'documents',
  'chunks',
  'budget_alerts',
  'model_test_results',
  'provider_keys',
];

function freshDb(): DatabaseSync {
  return openDatabase(':memory:');
}

function userTableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows
    .map((row) => row.name)
    .filter((name) => name !== 'schema_migrations');
}

describe('SQLite migrations', () => {

  it('creates all expected tables on migrateUp', () => {

    const db = freshDb();
    const applied = migrateUp(db);

    expect(applied).toHaveLength(16);
    expect(userTableNames(db)).toEqual([...EXPECTED_TABLES].sort());
  });

  it('is idempotent: a second migrateUp applies nothing', () => {
    const db = freshDb();
    migrateUp(db);

    expect(migrateUp(db)).toEqual([]);
  });

  it('reports no pending migrations after applying', () => {
    const db = freshDb();
    migrateUp(db);
    const status = migrationStatus(db);

    expect(status.pending).toEqual([]);
    expect(status.applied).toHaveLength(16);
  });

  it('reports all migrations pending on a fresh database', () => {
    const db = freshDb();
    const status = migrationStatus(db);

    expect(status.pending).toHaveLength(16);
    expect(status.applied).toEqual([]);
  });

  it('records a sha256 checksum for every applied migration', () => {
    const db = freshDb();
    migrateUp(db);

    const rows = db
      .prepare('SELECT checksum FROM schema_migrations')
      .all() as Array<{ checksum: string | null }>;
    expect(rows).toHaveLength(16);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('backfills checksums for a ledger created before checksum tracking', () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run('010_meta.sql', '2026-01-01T00:00:00.000Z');

    migrateUp(db);

    const row = db
      .prepare('SELECT checksum FROM schema_migrations WHERE name = ?')
      .get('010_meta.sql') as { checksum: string | null };
    const sql = readFileSync(join(getMigrationsDir(), '010_meta.sql'), 'utf8');
    expect(row.checksum).toBe(
      createHash('sha256').update(sql).digest('hex'),
    );
  });

  it('refuses to replay a renumbered migration still in the ledger', () => {
    const db = freshDb();
    migrateUp(db);
    // A deployment that ran 012 before the file was renamed to 016.
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(
      '016_allow_same_model_aliases.sql',
    );
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run('012_allow_same_model_aliases.sql', '2026-01-01T00:00:00.000Z');

    expect(() => migrateUp(db)).toThrowError(MigrationReplayError);
    expect(() => migrateUp(db)).toThrowError(/Refusing to replay "016_/);

    // Nothing ran: the new ledger row was not written and no residue exists.
    const ledger = db
      .prepare('SELECT name FROM schema_migrations')
      .all() as Array<{ name: string }>;
    expect(ledger.map((row) => row.name)).not.toContain(
      '016_allow_same_model_aliases.sql',
    );
    expect(ledger).toHaveLength(16);
    const residue = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='assignments_new'",
      )
      .get() as { n: number };
    expect(residue.n).toBe(0);
  });

  it('refuses to replay a renamed migration detected by checksum', () => {
    const db = freshDb();
    migrateUp(db);
    const sql = readFileSync(
      join(getMigrationsDir(), '016_allow_same_model_aliases.sql'),
      'utf8',
    );
    const checksum = createHash('sha256').update(sql).digest('hex');

    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(
      '016_allow_same_model_aliases.sql',
    );
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
    ).run('999_copied_aliases.sql', '2026-01-01T00:00:00.000Z', checksum);

    expect(() => migrateUp(db)).toThrowError(/checksum match/);
  });
});
