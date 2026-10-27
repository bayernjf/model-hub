#!/usr/bin/env node
// Migration CLI: node scripts/migrate.mjs up|status
// Requires the workspace to be built (imports from apps/hub/dist).
import { openDatabase } from '../apps/hub/dist/db/open.js';
import { migrateUp, migrationStatus } from '../apps/hub/dist/db/migrate.js';
import { ensureDataDir } from '../apps/hub/dist/storage/ensure-data-dir.js';
import { join } from 'node:path';

const command = process.argv[2];
const dataDir = process.env.HUB_DATA_DIR || './data';
const dbPath = join(dataDir, 'model-hub.db');

if (command !== 'up' && command !== 'status') {
  console.error('usage: node scripts/migrate.mjs up|status');
  process.exit(1);
}

ensureDataDir(dataDir);
const db = openDatabase(dbPath);

try {
  if (command === 'up') {
    const applied = migrateUp(db);
    console.log(
      `applied: ${applied.length === 0 ? '(none, already up to date)' : applied.join(', ')}`,
    );
  } else {
    const status = migrationStatus(db);
    console.log(`applied: ${status.applied.join(', ') || '(none)'}`);
    console.log(`pending: ${status.pending.join(', ') || '(none)'}`);
  }
} finally {
  db.close();
}
