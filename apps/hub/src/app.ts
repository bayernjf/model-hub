import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { healthRoutes } from './routes/health.js';

// Build the Hono app with the shared database connection. The factory (not a
// bound server) lets tests exercise app.request().
export function createApp(db: DatabaseSync): Hono {
  const app = new Hono();

  app.route('/', healthRoutes(db));

  app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  app.onError((err, c) => {
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
}
