import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { migrateUp } from './db/migrate.js';
import { ensureDataDir } from './storage/ensure-data-dir.js';

const config = loadConfig();
ensureDataDir(config.dataDir);

// Open the database and apply any pending migrations before listening.
const db = openDatabase(join(config.dataDir, 'model-hub.db'));
const applied = migrateUp(db);
if (applied.length > 0) {
  console.log(`migrations applied: ${applied.join(', ')}`);
}

const app = createApp(db);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const mode = config.devNoAuth ? ' (dev-no-auth)' : '';
  console.log(
    `model-hub listening on http://localhost:${info.port}${mode}, data=${config.dataDir}`,
  );
});
