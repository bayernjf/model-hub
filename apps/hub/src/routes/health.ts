import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { SERVICE_VERSION } from '../version.js';

export function healthRoutes(db: DatabaseSync): Hono {
  const routes = new Hono();

  // Liveness probe: no storage access, must answer even when the database
  // is unavailable.
  routes.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      service: 'model-hub',
      version: SERVICE_VERSION,
      uptime_s: Math.round(process.uptime()),
    }),
  );

  // Readiness probe: verifies the database is reachable and migrated.
  routes.get('/readyz', (c) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      return c.json({ ready: true });
    } catch {
      return c.json({ ready: false }, 503);
    }
  });

  return routes;
}
