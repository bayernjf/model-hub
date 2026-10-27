import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.HUB_PORT ?? 8791);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`invalid HUB_PORT: ${process.env.HUB_PORT ?? ''}`);
}

const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`model-hub listening on http://localhost:${info.port}`);
});
