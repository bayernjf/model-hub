import { Hono } from 'hono';
import { healthRoutes } from './routes/health.js';

// Build the Hono app without binding to a port so tests can exercise
// app.request() and the server entry can bind it with @hono/node-server.
export function createApp(): Hono {
  const app = new Hono();

  app.route('/', healthRoutes);

  app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  app.onError((err, c) => {
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
}
