import { Hono } from 'hono';
import { SERVICE_VERSION } from '../version.js';

export const healthRoutes = new Hono();

// Liveness probe used by Docker healthcheck and ops tooling. No secrets,
// no storage access: must answer even when the database is unavailable.
healthRoutes.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    service: 'model-hub',
    version: SERVICE_VERSION,
    uptime_s: Math.round(process.uptime()),
  }),
);
