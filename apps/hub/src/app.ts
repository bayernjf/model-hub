import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { buildKeyRing } from './crypto/keyring.js';
import type { HubConfig } from './config.js';
import { ProviderRepository } from './repositories/providers.js';
import { ProjectRepository } from './repositories/projects.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/admin/providers.js';
import { projectRoutes } from './routes/admin/projects.js';
import { sessionRoutes } from './routes/admin/session.js';

// Build the Hono app with the shared config and database connection. The
// factory (not a bound server) lets tests exercise app.request().
export function createApp(config: HubConfig, db: DatabaseSync): Hono {
  const app = new Hono();

  const keyRing = buildKeyRing(config.masterKey);
  const providerRepo = new ProviderRepository(db, keyRing);
  const projectRepo = new ProjectRepository(db);

  app.route('/', healthRoutes(db));
  app.route('/api/admin', sessionRoutes(config, db));
  app.route('/api/admin/providers', providerRoutes(config, db, providerRepo));
  app.route('/api/admin/projects', projectRoutes(config, db, projectRepo));

  app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  app.onError((err, c) => {
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
}
