import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ensureDataDir } from './storage/ensure-data-dir.js';

const config = loadConfig();
ensureDataDir(config.dataDir);

const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const mode = config.devNoAuth ? ' (dev-no-auth)' : '';
  console.log(
    `model-hub listening on http://localhost:${info.port}${mode}, data=${config.dataDir}`,
  );
});
