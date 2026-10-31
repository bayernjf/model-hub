import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { buildKeyRing } from './crypto/keyring.js';
import type { HubConfig } from './config.js';
import { ProviderRepository } from './repositories/providers.js';
import { ProjectRepository } from './repositories/projects.js';
import { ModelRepository } from './repositories/models.js';
import { AssignmentRepository } from './repositories/assignments.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';
import { RevisionService } from './revision.js';
import { ProjectionService } from './projection.js';
import {
  HealthCheckRepository,
  UsageRepository,
} from './repositories/reporting.js';
import { KnowledgeRepository } from './knowledge/repository.js';
import { KnowledgeService } from './knowledge/service.js';
import type { KnowledgePortsResolver } from './knowledge/service.js';
import { createKnowledgePortsResolver } from './knowledge/ports.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/admin/providers.js';
import { projectRoutes } from './routes/admin/projects.js';
import { modelRoutes } from './routes/admin/models.js';
import { assignmentRoutes } from './routes/admin/assignments.js';
import { adminHealthRoutes } from './routes/admin/health.js';
import { adminCostRoutes } from './routes/admin/costs.js';
import { sessionRoutes } from './routes/admin/session.js';
import { pubRoutes } from './routes/pub.js';
import { knowledgeRoutes } from './routes/knowledge.js';

// Test seams: swap the production model-kit ports for fakes.
export interface AppOverrides {
  knowledgePorts?: KnowledgePortsResolver;
}

// Build the Hono app with the shared config and database connection. The
// factory (not a bound server) lets tests exercise app.request().
export function createApp(
  config: HubConfig,
  db: DatabaseSync,
  overrides: AppOverrides = {},
): Hono {
  const app = new Hono();

  const keyRing = buildKeyRing(config.masterKey);
  const providerRepo = new ProviderRepository(db, keyRing);
  const projectRepo = new ProjectRepository(db);
  const modelRepo = new ModelRepository(db);
  const assignmentRepo = new AssignmentRepository(db);
  // Connection tests: 20 per hour per IP.
  const testRateLimiter = new SlidingWindowRateLimiter(20, 3_600_000);
  const revision = new RevisionService(db);
  const projection = new ProjectionService(
    providerRepo,
    modelRepo,
    assignmentRepo,
  );
  const usageRepo = new UsageRepository(db);
  const healthRepo = new HealthCheckRepository(db);

  // Knowledge subdomain (M3): owner-scoped documents/chunks with embedding
  // through model-kit ports (faked via overrides in tests).
  const knowledgeRepo = new KnowledgeRepository(db);
  const knowledge = new KnowledgeService({
    repo: knowledgeRepo,
    ports: overrides.knowledgePorts ?? createKnowledgePortsResolver(config),
  });
  const knowledgeIngestLimiter = new SlidingWindowRateLimiter(30, 3_600_000);
  const knowledgeQueryLimiter = new SlidingWindowRateLimiter(120, 3_600_000);

  app.route('/', healthRoutes(db));
  app.route('/api/admin', sessionRoutes(config, db));
  app.route(
    '/api/admin/providers',
    providerRoutes(config, db, providerRepo, revision),
  );
  app.route('/api/admin/projects', projectRoutes(config, db, projectRepo));
  app.route(
    '/api/admin',
    modelRoutes(
      config,
      db,
      modelRepo,
      providerRepo,
      testRateLimiter,
      revision,
    ),
  );
  app.route(
    '/api/admin/assignments',
    assignmentRoutes(config, db, assignmentRepo, revision),
  );
  app.route(
    '/api/admin',
    adminHealthRoutes(config, healthRepo, revision),
  );
  app.route('/api/admin', adminCostRoutes(config, usageRepo));
  app.route(
    '/',
    pubRoutes({
      projectRepo,
      modelRepo,
      assignmentRepo,
      usageRepo,
      healthRepo,
      projection,
      revision,
    }),
  );
  app.route(
    '/',
    knowledgeRoutes({
      projectRepo,
      knowledge,
      ingestLimiter: knowledgeIngestLimiter,
      queryLimiter: knowledgeQueryLimiter,
    }),
  );

  app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  app.onError((err, c) => {
    console.error('unhandled error:', err);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
}
