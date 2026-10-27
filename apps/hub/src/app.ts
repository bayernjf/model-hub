import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { buildKeyRing } from './crypto/keyring.js';
import type { HubConfig } from './config.js';
import { ProviderRepository } from './repositories/providers.js';
import { ProjectRepository } from './repositories/projects.js';
import { ModelRepository } from './repositories/models.js';
import { AssignmentRepository } from './repositories/assignments.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/admin/providers.js';
import { projectRoutes } from './routes/admin/projects.js';
import { modelRoutes } from './routes/admin/models.js';
import { assignmentRoutes } from './routes/admin/assignments.js';
import { sessionRoutes } from './routes/admin/session.js';

// Build the Hono app with the shared config and database connection. The
// factory (not a bound server) lets tests exercise app.request().
export function createApp(config: HubConfig, db: DatabaseSync): Hono {
  const app = new Hono();

  const keyRing = buildKeyRing(config.masterKey);
  const providerRepo = new ProviderRepository(db, keyRing);
  const projectRepo = new ProjectRepository(db);
  const modelRepo = new ModelRepository(db);
  const assignmentRepo = new AssignmentRepository(db);
  // Connection tests: 20 per hour per IP.
  const testRateLimiter = new SlidingWindowRateLimiter(20, 3_600_000);

  app.route('/', healthRoutes(db));
  app.route('/api/admin', sessionRoutes(config, db));
  app.route('/api/admin/providers', providerRoutes(config, db, providerRepo));
  app.route('/api/admin/projects', projectRoutes(config, db, projectRepo));
  app.route(
    '/api/admin',
    modelRoutes(config, db, modelRepo, providerRepo, testRateLimiter),
  );
  app.route(
    '/api/admin/assignments',
    assignmentRoutes(config, db, assignmentRepo),
  );

  app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  app.onError((err, c) => {
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
}
