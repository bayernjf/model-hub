import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

// apps/hub/src/db/migrate.ts -> repo root is ../../../, then db/migrations.
const migrationsDir = fileURLToPath(
  new URL('../../../../db/migrations', import.meta.url),
);

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

// Apply every pending migration in filename order. Each migration is
// appended to schema_migrations after it succeeds.
export function migrateUp(db: DatabaseSync): string[] {
  ensureMigrationsTable(db);
  ensureMigrationChecksums(db);
  const applied = getAppliedMigrations(db);
  const appliedNow: string[] = [];

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
