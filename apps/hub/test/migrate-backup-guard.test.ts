import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  getMigrationsDir,
  migrateUp,
  MigrationBackupError,
} from '../src/db/migrate.js';
import { openDatabase } from '../src/db/open.js';

/**
 * The 016 rebuild has no DOWN and is not transactional, so the runner must
 * refuse it unless a verified snapshot exists. These tests drive real SQLite
 * files: a pre-016 database plus backup files in every broken shape, then one
 * good snapshot to prove the migration still runs when the guard is satisfied.
 */

const TARGET = '016_allow_same_model_aliases.sql';
const PRE_016_FILES = readdirSync(getMigrationsDir())
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .slice(0, 15);

function applyFirstMigrations(db: DatabaseSync, files: string[]): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL,
       checksum TEXT
     );`,
  );
  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, NULL)',
  );
  for (const file of files) {
    db.exec(readFileSync(join(getMigrationsDir(), file), 'utf8'));
    insert.run(file, '2026-11-01T00:00:00.000Z');
  }
}

function buildDb(dir: string, name: string, files: string[]): string {
  const dbPath = join(dir, name);
  const db = openDatabase(dbPath);
  applyFirstMigrations(db, files);
  db.close();
  return dbPath;
}

function snapshot(dbPath: string, backupPath: string, mode = 0o600): string {
  copyFileSync(dbPath, backupPath);
  chmodSync(backupPath, mode);
  return backupPath;
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-016-guard-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.HUB_BACKUP_PATH;
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('016 backup guard', () => {
  it('refuses to run when the backup path does not exist', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir, 'model-hub.db', PRE_016_FILES);
    process.env.HUB_BACKUP_PATH = join(dir, 'missing.db');
    const db = openDatabase(dbPath);

    expect(() => migrateUp(db)).toThrowError(MigrationBackupError);
    expect(() => migrateUp(db)).toThrowError(/backup not found/);

    // Nothing ran before the guard tripped.
    const ledger = db
      .prepare('SELECT name FROM schema_migrations')
      .all() as Array<{ name: string }>;
    expect(ledger.map((row) => row.name)).not.toContain(TARGET);
    const residue = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='assignments_new'",
      )
      .get() as { n: number };
    expect(residue.n).toBe(0);
    db.close();
  });

  it('refuses an empty (0 byte) backup file', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir, 'model-hub.db', PRE_016_FILES);
    const backupPath = join(dir, 'empty.db');
    writeFileSync(backupPath, '');
    chmodSync(backupPath, 0o600);
    process.env.HUB_BACKUP_PATH = backupPath;
    const db = openDatabase(dbPath);

    expect(() => migrateUp(db)).toThrowError(/is empty \(0 bytes\)/);
    db.close();
  });

  it('refuses a snapshot that is world-readable', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir, 'model-hub.db', PRE_016_FILES);
    const backupPath = snapshot(dbPath, join(dir, 'hub-0644.db'), 0o644);
    process.env.HUB_BACKUP_PATH = backupPath;
    const db = openDatabase(dbPath);

    expect(() => migrateUp(db)).toThrowError(/expected 600/);
    db.close();
  });

  it('refuses a snapshot taken before the last applied migration', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir, 'model-hub.db', PRE_016_FILES);
    // 14-row snapshot vs 15 applied: restoring it would lose one migration.
    const stalePath = buildDb(dir, 'stale.db', PRE_016_FILES.slice(0, 14));
    const backupPath = snapshot(stalePath, join(dir, 'hub-stale.db'));
    process.env.HUB_BACKUP_PATH = backupPath;
    const db = openDatabase(dbPath);

    expect(() => migrateUp(db)).toThrowError(/snapshot is stale/);
    db.close();
  });

  it('applies 016 once a verified snapshot of the same database exists', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir, 'model-hub.db', PRE_016_FILES);
    const backupPath = snapshot(dbPath, join(dir, 'hub-20261107-120000.db'));
    process.env.HUB_BACKUP_PATH = backupPath;
    const db = openDatabase(dbPath);

    expect(migrateUp(db)).toEqual([TARGET]);

    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='assignments'")
        .get() as { sql: string }
    ).sql.replace(/\s+/g, ' ');
    expect(tableSql).toContain('UNIQUE (project_id, alias)');
    expect(tableSql).not.toContain('UNIQUE (project_id, model_id)');
    db.close();
  });

  it('lets a brand-new file-backed database migrate without a backup', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'model-hub.db');
    const db = openDatabase(dbPath);

    expect(migrateUp(db)).toHaveLength(16);
    db.close();
  });
});
