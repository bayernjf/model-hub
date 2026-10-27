import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { createApp } from './app.js';
import { isBackendPath } from './backend-routes.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { migrateUp } from './db/migrate.js';
import { ensureDataDir } from './storage/ensure-data-dir.js';

type NodeListener = (req: IncomingMessage, res: ServerResponse) => void;

const config = loadConfig();
ensureDataDir(config.dataDir);

// Open the database and apply any pending migrations before listening.
const db = openDatabase(join(config.dataDir, 'model-hub.db'));
const applied = migrateUp(db);
if (applied.length > 0) {
  console.log(`migrations applied: ${applied.join(', ')}`);
}

const app = createApp(config, db);
const honoListener = getRequestListener((request) => app.fetch(request));

// The Astro SSR handler is built into web/dist. Resolve it via a computed URL
// so the same relative path works from src/ and the compiled dist/ output.
const entryUrl = new URL('../web/dist/server/entry.mjs', import.meta.url);
if (!existsSync(entryUrl)) {
  console.error(
    'Astro console not built; run `npm run build -w @model-hub/web` first.',
  );
  process.exit(1);
}

// Import the handler without letting its standalone autostart bind a port.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const astroEntry = (await import(entryUrl.href)) as {
  handler: NodeListener;
};
const astroHandler = astroEntry.handler;

// Hono owns the API, public projection and probes; everything else
// renders via Astro.
const server = createServer((req, res) => {
  if (req.url && isBackendPath(req.url)) {
    void honoListener(req, res);
  } else {
    astroHandler(req, res);
  }
});

server.listen(config.port, () => {
  const mode = config.devNoAuth ? ' (dev-no-auth)' : '';
  console.log(
    `model-hub listening on http://localhost:${config.port}${mode}, data=${config.dataDir}`,
  );
});
