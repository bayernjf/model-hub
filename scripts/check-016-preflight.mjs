#!/usr/bin/env node
// Read-only preflight for migration 016 (assignments table rebuild).
// Source of truth: bayjf/docs/ops/prod-migrations-execution-cards-2026-11-05.md §一.
// Usage:
//   node --experimental-sqlite scripts/check-016-preflight.mjs \
//     [--db <path>] [--backup <path>]
// Defaults: db = $HUB_DATA_DIR (or ./data) + model-hub.db,
//           backup = newest backups/hub-*.db under the repo root.
// Exit 0 = every check passed; exit 1 = at least one failed (details printed).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = join(repoRoot, 'db/migrations');
const backupsDir = join(repoRoot, 'backups');

const TARGET = '016_allow_same_model_aliases.sql';
const REQUIRED_APPLIED = ['014_provider_keys.sql', '015_model_test_results.sql'];
const EXPECTED_COLUMNS = [
  'id',
  'project_id',
  'model_id',
  'role',
  'alias',
  'daily_budget_micros',
  'created_at',
  'updated_at',
];
const EXPECTED_INDEXES = ['idx_assignments_project', 'idx_assignments_model'];

function usage() {
  console.log(
    'usage: node --experimental-sqlite scripts/check-016-preflight.mjs [--db <path>] [--backup <path>]\n' +
      '  --db      SQLite file to inspect (default: $HUB_DATA_DIR or ./data, model-hub.db)\n' +
      '  --backup  backup file to verify (default: newest backups/hub-*.db)\n' +
      'Read-only: opens every database with readOnly=true and writes nothing.',
  );
}

function parseArgs(argv) {
  const out = { db: null, backup: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--db' || arg === '--backup') {
      const value = argv[i + 1];
      if (!value) {
        console.error(`missing value for ${arg}`);
        usage();
        process.exit(1);
      }
      out[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }
  return out;
}

function defaultDbPath() {
  const dataDir = process.env.HUB_DATA_DIR || './data';
  return join(dataDir, 'model-hub.db');
}

function newestBackupPath() {
  if (!existsSync(backupsDir)) return null;
  const files = readdirSync(backupsDir)
    .filter((name) => /^hub-.*\.db$/.test(name))
    .map((name) => join(backupsDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function listMigrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function hasTable(db, name) {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function tableSql(db, name) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row?.sql ?? '';
}

function tableColumns(db, name) {
  return db
    .prepare(`PRAGMA table_info(${name})`)
    .all()
    .map((column) => column.name);
}

function indexNames(db, table) {
  return db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((index) => index.name);
}

// Small helper so checks can fail with a concise, human-readable reason.
class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message);
}

function check(results, label, section, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, label, section, detail });
  } catch (error) {
    results.push({
      ok: false,
      label,
      section,
      detail: error instanceof CheckFailure ? error.message : String(error),
    });
  }
}

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db || defaultDbPath();
const backupPath = args.backup || newestBackupPath();

const results = [];

function runDbChecks() {
  if (!existsSync(dbPath)) {
    check(results, `database file exists (${dbPath})`, '§7(a)', () =>
      fail('file not found'),
    );
    return null;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    check(results, `database opens read-only (${dbPath})`, '§7(a)', () =>
      fail(String(error.message || error)),
    );
    return null;
  }

  try {
    check(results, 'database file exists and opens read-only', '§7(a)', () =>
      'opened',
    );

    // --- Ledger: migrations that must already be applied (card §2).
    let applied;
    check(results, 'schema_migrations table exists', '§2', () => {
      if (!hasTable(db, 'schema_migrations')) {
        fail('table missing: schema_migrations');
      }
      applied = new Set(
        db
          .prepare('SELECT name FROM schema_migrations')
          .all()
          .map((row) => row.name),
      );
      return `${applied.size} applied`;
    });

    if (applied) {
      check(results, '014_provider_keys.sql applied', '§2 额外前置', () => {
        if (!applied.has(REQUIRED_APPLIED[0])) {
          fail(`${REQUIRED_APPLIED[0]} not in schema_migrations`);
        }
        return 'yes';
      });
      check(results, '015_model_test_results.sql applied', '§2 前置条件', () => {
        if (!applied.has(REQUIRED_APPLIED[1])) {
          fail(`${REQUIRED_APPLIED[1]} not in schema_migrations`);
        }
        return 'yes';
      });

      const files = listMigrationFiles();
      // --- Pending set must be exactly 016 (card §5 step 2).
      check(results, 'pending migrations are exactly 016', '§5 步骤2', () => {
        const pending = files.filter((name) => !applied.has(name));
        if (pending.length !== 1 || pending[0] !== TARGET) {
          fail(
            pending.length === 0
              ? 'nothing pending: 016 is already applied (ledger and schema disagree)'
              : `unexpected pending: ${pending.join(', ')}`,
          );
        }
        return 'only 016';
      });
    } else {
      check(results, 'pending migrations are exactly 016', '§5 步骤2', () =>
        fail('schema_migrations is unreadable, pending set cannot be computed'),
      );
    }

    // --- Pre-016 shape of assignments (card §7(a)).
    check(results, 'assignments table exists', '§7(a)', () => {
      if (!hasTable(db, 'assignments')) fail('table missing: assignments');
      return 'yes';
    });

    if (hasTable(db, 'assignments')) {
      const columns = tableColumns(db, 'assignments');
      check(results, 'assignments columns match 016 SELECT list', '§7(a)', () => {
        if (columns.join(',') !== EXPECTED_COLUMNS.join(',')) {
          fail(`expected [${EXPECTED_COLUMNS.join(', ')}], got [${columns.join(', ')}]`);
        }
        return columns.join(', ');
      });

      check(results, 'old UNIQUE(project_id, model_id) still present', '§7(a)', () => {
        const sql = tableSql(db, 'assignments').replace(/\s+/g, ' ');
        if (!/UNIQUE\s*\(\s*project_id\s*,\s*model_id\s*\)/i.test(sql)) {
          fail('old UNIQUE(project_id, model_id) not found; assignments looks already rebuilt');
        }
        return 'yes';
      });

      check(results, 'assignments row count (record as N)', '§7(a)', () => {
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM assignments').get();
        return `${n} rows`;
      });

      check(results, 'assignments indexes present', '§7(a)', () => {
        const indexes = indexNames(db, 'assignments');
        const missing = EXPECTED_INDEXES.filter((name) => !indexes.includes(name));
        if (missing.length > 0) fail(`missing index(es): ${missing.join(', ')}`);
        return EXPECTED_INDEXES.join(', ');
      });
    }

    check(results, 'assignments_new is absent (no residue)', '§7(a)', () => {
      if (!hasTable(db, 'assignments_new')) return 'absent';
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM assignments_new').get();
      fail(`table assignments_new exists with ${n} rows (previous run left residue)`);
    });

    // --- Objects that must exist once 015 has been applied (card §2 / §7(b)).
    check(results, 'model_test_results table exists (015)', '§2 前置条件', () => {
      if (!hasTable(db, 'model_test_results')) fail('table missing: model_test_results');
      return 'yes';
    });

    check(results, 'idx_model_test_results_model exists (015)', '§2 前置条件', () => {
      const indexes = indexNames(db, 'model_test_results');
      if (!indexes.includes('idx_model_test_results_model')) {
        fail('index missing: idx_model_test_results_model');
      }
      return 'yes';
    });

    return applied ? applied.size : null;
  } finally {
    db.close();
  }
}

function runBackupChecks(appliedCount) {
  if (!backupPath) {
    check(results, 'backup file present (backups/hub-*.db)', '§6 判定2', () =>
      fail('no backups/hub-*.db found; create one with `docker compose run --rm -e BACKUP_ONCE=1 backup`'),
    );
    return;
  }

  let stat;
  check(results, `backup exists and is non-empty (${backupPath})`, '§6 判定2', () => {
    if (!existsSync(backupPath)) fail('file not found');
    stat = statSync(backupPath);
    if (stat.size === 0) fail('0 bytes');
    return `${stat.size} bytes`;
  });

  if (!stat) return;

  check(results, 'backup permission is 600', '§6 判定3', () => {
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) fail(`mode is ${mode.toString(8).padStart(3, '0')}, expected 600`);
    return '600';
  });

  let backup;
  try {
    backup = new DatabaseSync(backupPath, { readOnly: true });
  } catch (error) {
    check(results, 'backup opens read-only', '§6 判定4', () =>
      fail(String(error.message || error)),
    );
    return;
  }

  try {
    check(results, 'backup PRAGMA integrity_check = ok', '§6 判定4', () => {
      const rows = backup.prepare('PRAGMA integrity_check').all();
      const messages = rows.map((row) => row.integrity_check);
      if (messages.length !== 1 || messages[0] !== 'ok') {
        fail(`integrity_check: ${messages.join('; ')}`);
      }
      return 'ok';
    });

    check(results, 'backup PRAGMA foreign_key_check is empty', '§7(b)', () => {
      const rows = backup.prepare('PRAGMA foreign_key_check').all();
      if (rows.length > 0) fail(`${rows.length} violation(s)`);
      return 'none';
    });

    check(results, 'backup ledger rows match applied count', '§6 判定5', () => {
      if (appliedCount === null) {
        fail('current database ledger was unreadable, cannot compare');
      }
      const count = hasTable(backup, 'schema_migrations')
        ? backup.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n
        : 0;
      if (count !== appliedCount) {
        fail(`backup has ${count} rows, current db applied ${appliedCount}`);
      }
      return `${count} rows`;
    });
  } finally {
    backup.close();
  }
}

console.log('== model-hub 016 preflight (read-only) ==');
console.log(`db:     ${dbPath}`);
console.log(`backup: ${backupPath ?? '(none found)'}`);

const appliedCount = runDbChecks();
runBackupChecks(appliedCount);

console.log('');
for (const result of results) {
  const tag = result.ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${result.label} (card ${result.section}) - ${result.detail}`);
}

const failed = results.filter((result) => !result.ok);
console.log('');
if (failed.length > 0) {
  console.log(`RESULT: FAIL (${failed.length}/${results.length} checks failed) - do not run 016 until fixed (card §一)`);
  process.exit(1);
}

console.log(`RESULT: PASS (${results.length} checks) - safe to proceed with card §5 step 2`);
