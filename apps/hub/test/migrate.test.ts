import { describe, expect, it } from 'vitest';
import { migrateUp, migrationStatus } from '../src/db/migrate.js';
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

    expect(applied).toHaveLength(13);
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
    expect(status.applied).toHaveLength(13);
  });

  it('reports all migrations pending on a fresh database', () => {
    const db = freshDb();
    const status = migrationStatus(db);

    expect(status.pending).toHaveLength(13);
    expect(status.applied).toEqual([]);
  });
});
