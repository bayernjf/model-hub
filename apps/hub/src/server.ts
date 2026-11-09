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
import { hasAdminSession, isPublicPagePath } from './web-guard.js';

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
// Forward the node bindings (2nd arg) so getConnInfo can read the peer
// socket; dropping it makes isLoopbackPeer fail closed and silently
// disables HUB_DEV_NO_AUTH at runtime.
const honoListener = getRequestListener((request, env) =>
  app.fetch(request, env),
);

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
    return;
  }

  // Page requests skip Hono entirely, so this is the only place that can hold
  // the console behind a session. Without it every page answers 200 to anyone
  // who can reach the port, exposing the whole admin shell.
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (
    !isPublicPagePath(pathname) &&
    !hasAdminSession(req.headers.cookie ?? null, config)
  ) {
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  astroHandler(req, res);
});

server.listen(config.port, config.host, () => {
  if (config.devNoAuth) {
    console.error(
      'WARNING: HUB_DEV_NO_AUTH=1 — admin auth is DISABLED for loopback peers. ' +
        'Never use this outside local development.',
    );
  }
  const mode = config.devNoAuth ? ' (dev-no-auth)' : '';
  // Log the address the socket actually bound, not the configured host:
  // `0.0.0.0` and `::` are what the OS reports for "all interfaces".
  const address = server.address();
  const boundHost =
    typeof address === 'object' && address ? address.address : config.host;
  const boundPort =
    typeof address === 'object' && address ? address.port : config.port;
  const shownHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  console.log(
    `model-hub listening on http://${shownHost}:${boundPort}${mode}, data=${config.dataDir}`,
  );
});
