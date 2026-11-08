#!/usr/bin/env node
// @ts-check
/**
 * Restore path for model-hub (2026-11-08: `backup-hub.sh` existed, restore did
 * not — a backup you cannot safely restore is not a backup).
 *
 * Snapshots are flat `hub-YYYYMMDD-HHMMSS.db` files produced by
 * `scripts/backup-hub.sh` (VACUUM INTO). This script refuses to be optimistic:
 *
 *   1. verify the snapshot with integrity_check plus key-table counts;
 *   2. refuse to overwrite a live database without --force;
 *   3. with --force, keep the current file as `.pre-restore-<stamp>`;
 *   4. re-verify the file actually written before reporting success.
 *
 * Snapshots hold envelope ciphertext, so they are useless without
 * `HUB_MASTER_KEY`. A missing key is reported loudly but does not block the
 * restore: the key may live in the surrounding shell or compose env.
 *
 * CLI:
 *   node --experimental-sqlite scripts/restore-hub.mjs --snapshot /backups/hub-20261108-000000.db \
 *     [--target-db /data/model-hub.db] [--force]
 */
import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

/** Tables that must exist after a restore, in blast-radius order. */
const KEY_TABLES = [
  'projects',
  'provider_keys',
  'tokens',
  'assignments',
  'usage_events',
  'documents',
  'chunks',
];

class RestoreError extends Error {}

/** @param {Date} now */
function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', 'T');
}

/**
 * @param {string} dbFile
 * @returns {Record<string, number>}
 */
function verify(dbFile) {
  const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const value = integrity === undefined ? '' : String(Object.values(integrity)[0] ?? '');
    if (value !== 'ok') throw new RestoreError(`integrity_check failed: ${value}`);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const table of KEY_TABLES) {
      try {
        const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
        counts[table] = Number(row?.c ?? 0);
      } catch {
        // Absent table stays absent in the report; it is not a zero row count.
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{snapshot?:string, target?:string, force:boolean}} */
  const parsed = { force: argv.includes('--force') };
  for (const [flag, key] of /** @type {const} */ ([
    ['--snapshot', 'snapshot'],
    ['--target-db', 'target'],
  ])) {
    const index = argv.indexOf(flag);
    if (index >= 0) {
      const value = argv[index + 1];
      if (value === undefined) throw new RestoreError(`${flag} requires a value`);
      parsed[key] = value;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.snapshot === undefined) {
    throw new RestoreError('usage: restore-hub.mjs --snapshot <file.db> [--target-db <path>] [--force]');
  }
  if (!existsSync(args.snapshot)) throw new RestoreError(`snapshot not found: ${args.snapshot}`);

  const snapshotCounts = verify(args.snapshot);
  // A file that verifies but has no projects table is not a model-hub database
  // (an unmigrated or wrong file). Restoring it would start a hub that serves
  // an empty schema without complaint.
  if (snapshotCounts.projects === undefined) {
    throw new RestoreError(
      `snapshot has no projects table: ${args.snapshot} is not a migrated model-hub database`,
    );
  }

  const target = args.target ?? process.env.HUB_DB_PATH ?? '/data/model-hub.db';
  if (existsSync(target)) {
    if (!args.force) {
      throw new RestoreError(
        `target exists: ${target} — re-run with --force to overwrite (it will be kept as .pre-restore)`,
      );
    }
    const keepPath = `${target}.pre-restore-${stamp(new Date())}`;
    copyFileSync(target, keepPath);
    chmodSync(keepPath, 0o600);
    console.log(`kept previous db at ${keepPath}`);
  }

  copyFileSync(args.snapshot, target);
  chmodSync(target, 0o600);

  const restored = verify(target);
  for (const [table, expected] of Object.entries(snapshotCounts)) {
    if (restored[table] !== expected) {
      throw new RestoreError(
        `restored file does not match the snapshot: ${table} expected ${expected}, found ${String(restored[table])}`,
      );
    }
  }

  const counts = Object.entries(restored)
    .map(([table, count]) => `${table}=${count}`)
    .join(' ');
  console.log(`restored ${target} from ${args.snapshot} (${counts})`);

  // Ciphertext without the key is a dead backup: say so instead of pretending.
  const masterKey = process.env.HUB_MASTER_KEY;
  if (masterKey === undefined || masterKey === '') {
    console.error(
      'restore-hub: HUB_MASTER_KEY is not set — provider-key envelopes will not decrypt. ' +
        'Set the same key the backup was produced with, then restart model-hub.',
    );
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('restore-hub.mjs') || process.argv[1].endsWith('restore-hub'));

if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    console.error(`restore-hub: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
