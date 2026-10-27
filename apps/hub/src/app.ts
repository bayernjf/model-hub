import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { HubConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/admin/session.js';

// Build the Hono app with the shared config and database connection. The
// factory (not a bound server) lets tests exercise app.request().
export function createApp(config: HubConfig, db: DatabaseSync): Hono {
  const app = new Hono();

  app.route('/', healthRoutes(db));
  app.route('/api/admin', sessionRoutes(config, db));

  app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  app.onError((err, c) => {
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
}
