#!/usr/bin/env node
// Read-only preflight for the future migration that drops the legacy
// providers.api_key_cipher / api_key_hint columns.
//
// The provider key pool (migration 014) is the source of truth; the legacy
// columns remain only as a migration-period fallback in ProjectionService.
// Dropping them is safe ONLY when every provider that still carries a legacy
// key also has at least one usable pool row, so no credential would be lost.
//
// Usage:
//   node --experimental-sqlite scripts/check-legacy-key-drop-preflight.mjs [--db <path>]
// Default db: $HUB_DATA_DIR (or ./data) + model-hub.db.
// Exit 0 = safe to author the drop migration; exit 1 = blocking gap found.
// Read-only: opens the database with readOnly=true and writes nothing.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function usage() {
  console.log(
    'usage: node --experimental-sqlite scripts/check-legacy-key-drop-preflight.mjs [--db <path>]\n' +
      'Read-only: verifies every legacy-key provider has a usable key-pool row.',
  );
}

const args = process.argv.slice(2);
let dbPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--help' || args[i] === '-h') {
    usage();
    process.exit(0);
  }
  if (args[i] === '--db') {
    dbPath = args[i + 1];
    i += 1;
    continue;
  }
  console.error(`unknown argument: ${args[i]}`);
  usage();
  process.exit(1);
}
if (!dbPath) {
  const dataDir = process.env.HUB_DATA_DIR || './data';
  dbPath = join(dataDir, 'model-hub.db');
}

const results = [];
function check(label, fn) {
  try {
    results.push({ ok: true, label, detail: fn() });
  } catch (error) {
    results.push({ ok: false, label, detail: error.message });
  }
}

function hasTable(db, name) {
  return Boolean(
    db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

// Static guard: the projection must still contain its legacy fallback until
// the drop migration lands; this script flips to FAIL once someone removes the
// fallback without also shipping the column drop, keeping the two in lockstep.
function projectionStillHasFallback() {
  const source = readFileSync(join(repoRoot, 'apps/hub/src/projection.ts'), 'utf8');
  return source.includes("revealKey") && source.includes('migration period');
}

console.log('== model-hub legacy-key drop preflight (read-only) ==');
console.log(`db: ${dbPath}`);

if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  check('provider_keys table exists (014 applied)', () => {
    if (!hasTable(db, 'provider_keys')) throw new Error('provider_keys missing; run migration 014 first');
    return 'yes';
  });

  check('providers still carries the legacy columns', () => {
    const cols = db.prepare('PRAGMA table_info(providers)').all().map((c) => c.name);
    if (!cols.includes('api_key_cipher') || !cols.includes('api_key_hint')) {
      throw new Error('legacy columns already absent — nothing to gate, drop migration may have run');
    }
    return 'api_key_cipher, api_key_hint present';
  });

  // The blocking data check: no legacy-key provider may be left without a pool.
  check('every legacy-key provider has >=1 usable pool key', () => {
    const rows = db
      .prepare(
        `SELECT p.id, p.name,
                COUNT(pk.id) AS pool_rows,
                SUM(CASE WHEN pk.is_active = 1
                          AND (pk.status = 'ok' OR pk.cooled_until IS NULL OR pk.cooled_until <= datetime('now'))
                         THEN 1 ELSE 0 END) AS usable_rows
           FROM providers p
           LEFT JOIN provider_keys pk ON pk.provider_id = p.id
          WHERE p.api_key_cipher IS NOT NULL
          GROUP BY p.id`,
      )
      .all();
    const stranded = rows.filter((r) => Number(r.usable_rows) < 1);
    if (stranded.length > 0) {
      throw new Error(
        `providers with a legacy key but no usable pool row: ${stranded
          .map((r) => `${r.id}(${r.name})`)
          .join(', ')}`,
      );
    }
    return `${rows.length} legacy-key provider(s), all covered`;
  });

  check('no orphan pool rows point at a missing provider', () => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM provider_keys pk
          LEFT JOIN providers p ON p.id = pk.provider_id
          WHERE p.id IS NULL`,
      )
      .get();
    if (Number(row.n) > 0) throw new Error(`${row.n} orphan provider_keys row(s)`);
    return 'none';
  });

  check('projection legacy fallback still present (lockstep guard)', () => {
    if (!projectionStillHasFallback()) {
      throw new Error('projection fallback removed without the column-drop migration; re-add or ship the drop');
    }
    return 'fallback present';
  });
} finally {
  db.close();
}

console.log('');
for (const result of results) {
  console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.label} - ${result.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.log(`RESULT: FAIL (${failed.length}/${results.length}) - do not drop the legacy key columns yet`);
  process.exit(1);
}
console.log(`RESULT: PASS (${results.length} checks) - a drop migration would lose no credentials`);
