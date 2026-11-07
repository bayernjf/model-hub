import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { sqlite } from './open.js';

// apps/hub/src/db/migrate.ts -> repo root is ../../../, then db/migrations.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const migrationsDir = join(repoRoot, 'db/migrations');
const backupsDir = join(repoRoot, 'backups');

// Migrations that rewrite or drop existing data in place and have no DOWN.
// The runner refuses to execute them on an already-initialised database unless
// a verified snapshot exists: 016 rebuilds `assignments`, so a failure between
// DROP and RENAME leaves the table missing and only a backup can recover it.
// There is deliberately no bypass switch — point HUB_BACKUP_PATH at a real
// snapshot or the migration does not run.
const BACKUP_REQUIRED_MIGRATIONS = new Set(['016_allow_same_model_aliases.sql']);

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

// Thrown before any SQL runs when a pending file looks like a renumbered
// migration that the ledger already applied under a different name.
export class MigrationReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationReplayError';
  }
}

// Thrown before any SQL runs when a destructive migration has no usable
// snapshot to fall back on (missing file, 0 bytes, wrong permissions, damaged
// file, or a ledger that does not match the database being migrated).
export class MigrationBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationBackupError';
  }
}

// Explicit HUB_BACKUP_PATH wins; otherwise use the newest snapshot written by
// scripts/backup-hub.sh (backups/hub-*.db). Returns null when nothing exists.
function resolveBackupPath(): string | null {
  const explicit = process.env.HUB_BACKUP_PATH?.trim();
  if (explicit) return explicit;
  if (!existsSync(backupsDir)) return null;
  const files = readdirSync(backupsDir)
    .filter((name) => /^hub-.*\.db$/.test(name))
    .map((name) => join(backupsDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

// Fail closed unless the snapshot is a non-empty, 0600, integrity-clean copy of
// this database at the current ledger position.
function assertBackupReady(file: string, appliedCount: number): void {
  const backupPath = resolveBackupPath();
  if (!backupPath) {
    throw new MigrationBackupError(
      `Refusing to run "${file}" on an initialised database: no backup found. ` +
        'Create one with `docker compose run --rm -e BACKUP_ONCE=1 backup` and ' +
        'point HUB_BACKUP_PATH at the resulting backups/hub-*.db file.',
    );
  }
  if (!existsSync(backupPath)) {
    throw new MigrationBackupError(
      `Refusing to run "${file}": backup not found at ${backupPath}. ` +
        'Create a snapshot first; there is no bypass flag.',
    );
  }
  const stat = statSync(backupPath);
  if (stat.size === 0) {
    throw new MigrationBackupError(
      `Refusing to run "${file}": backup ${backupPath} is empty (0 bytes).`,
    );
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new MigrationBackupError(
      `Refusing to run "${file}": backup ${backupPath} has mode ` +
        `${mode.toString(8).padStart(3, '0')}, expected 600 (snapshots hold secrets).`,
    );
  }

  let backup: DatabaseSync;
  try {
    backup = new sqlite.DatabaseSync(backupPath, { readOnly: true });
  } catch (error) {
    throw new MigrationBackupError(
      `Refusing to run "${file}": backup ${backupPath} cannot be opened read-only ` +
        `(${(error as Error).message}).`,
    );
  }
  try {
    const integrity = backup
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => (row as { integrity_check: string }).integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new MigrationBackupError(
        `Refusing to run "${file}": backup integrity_check -> ${integrity.join('; ')}.`,
      );
    }
    let backupLedger = 0;
    try {
      backupLedger = (
        backup.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
          n: number;
        }
      ).n;
    } catch {
      throw new MigrationBackupError(
        `Refusing to run "${file}": backup has no schema_migrations ledger.`,
      );
    }
    if (backupLedger !== appliedCount) {
      throw new MigrationBackupError(
        `Refusing to run "${file}": backup ledger has ${backupLedger} rows but ` +
          `this database has ${appliedCount} applied; the snapshot is stale.`,
      );
    }
  } finally {
    backup.close();
  }
}

interface AppliedMigrationRow {
  name: string;
  checksum: string | null;
}

function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

// Filename without its numeric prefix, used to spot renumbered migrations
// (e.g. 012_allow_same_model_aliases.sql -> 016_allow_same_model_aliases.sql).
function migrationSlug(name: string): string {
  return name.replace(/^\d+_/, '');
}

export function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT
    );
  `);
}

// Ledgers created before checksums were tracked are upgraded in place. This is
// bookkeeping only; it does not change which migrations are pending.
export function ensureMigrationChecksums(db: DatabaseSync): void {
  const columns = db
    .prepare('PRAGMA table_info(schema_migrations)')
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'checksum')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  }

  const files = new Set(listMigrationFiles());
  const legacy = db
    .prepare('SELECT name, checksum FROM schema_migrations WHERE checksum IS NULL')
    .all() as unknown as AppliedMigrationRow[];
  const update = db.prepare(
    'UPDATE schema_migrations SET checksum = ? WHERE name = ?',
  );
  for (const row of legacy) {
    if (!files.has(row.name)) continue;
    const sql = readFileSync(join(migrationsDir, row.name), 'utf8');
    update.run(migrationChecksum(sql), row.name);
  }
}

function getAppliedMigrations(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function getAppliedRows(db: DatabaseSync): AppliedMigrationRow[] {
  return db
    .prepare('SELECT name, checksum FROM schema_migrations')
    .all() as unknown as AppliedMigrationRow[];
}

// Returns a readable reason when `file` must not run, or null when it is safe.
function findReplayConflict(
  db: DatabaseSync,
  file: string,
  checksum: string,
): string | null {
  const files = new Set(listMigrationFiles());
  for (const row of getAppliedRows(db)) {
    if (row.name === file) continue;
    if (row.checksum && row.checksum === checksum) {
      return `its content is identical to ledger row "${row.name}" (checksum match)`;
    }
    if (!files.has(row.name) && migrationSlug(row.name) === migrationSlug(file)) {
      return `the ledger still records "${row.name}", which is this migration under its old number (renamed without content changes)`;
    }
  }
  return null;
}

// `PRAGMA database_list` reports file='' for an in-memory database.
function isFileBacked(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{
    name: string;
    file: string;
  }>;
  const main = rows.find((row) => row.name === 'main');
  return Boolean(main?.file);
}

// Apply every pending migration in filename order. Each migration is
// appended to schema_migrations after it succeeds.
export function migrateUp(db: DatabaseSync): string[] {
  ensureMigrationsTable(db);
  ensureMigrationChecksums(db);
  const applied = getAppliedMigrations(db);
  const appliedNow: string[] = [];
  // A fresh database has nothing to lose, so destructive migrations may run
  // without a snapshot. Any file-backed database that is already initialised
  // must prove a usable backup before the destructive file executes. An in-memory
  // database (tests, throwaway runs) is exempt: there is no file to snapshot.
  const initialised = applied.size > 0 && isFileBacked(db);

  for (const file of listMigrationFiles()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = migrationChecksum(sql);
    const conflict = findReplayConflict(db, file, checksum);
    if (conflict) {
      throw new MigrationReplayError(
        `Refusing to replay "${file}": ${conflict}. ` +
          'No SQL was executed. Verify the schema, then either mark it applied ' +
          `(INSERT INTO schema_migrations (name, applied_at, checksum) VALUES ('${file}', <timestamp>, '${checksum}')) ` +
          'or remove the stale ledger row before restarting.',
      );
    }
    if (initialised && BACKUP_REQUIRED_MIGRATIONS.has(file)) {
      assertBackupReady(file, applied.size);
    }
    db.exec(sql);
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
    ).run(file, new Date().toISOString(), checksum);
    appliedNow.push(file);
  }

  return appliedNow;
}

export function migrationStatus(db: DatabaseSync): MigrationStatus {
  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);
  const all = listMigrationFiles();
  return {
    applied: all.filter((file) => applied.has(file)),
    pending: all.filter((file) => !applied.has(file)),
  };
}

export function getMigrationsDir(): string {
  return migrationsDir;
}
