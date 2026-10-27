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

function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function getAppliedMigrations(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

// Apply every pending migration in filename order. Each migration is
// appended to schema_migrations after it succeeds.
export function migrateUp(db: DatabaseSync): string[] {
  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);
  const appliedNow: string[] = [];

  for (const file of listMigrationFiles()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec(sql);
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run(file, new Date().toISOString());
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
