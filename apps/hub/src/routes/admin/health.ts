import { Hono } from 'hono';
import {
  requireAdmin,
  type AppEnv,
} from '../../auth/middleware.js';
import type { HubConfig } from '../../config.js';
import type { HealthCheckRepository } from '../../repositories/reporting.js';
import type { RevisionService } from '../../revision.js';

export function adminHealthRoutes(
  config: HubConfig,
  healthRepo: HealthCheckRepository,
  revision: RevisionService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  // Latest reported L3/L4 results, optionally scoped to a project.
  routes.get('/health-checks', (c) => {
    const projectId = c.req.query('project');
    if (projectId) {
      return c.json({ health_checks: healthRepo.latestByProject(projectId) });
    }
    return c.json({ health_checks: healthRepo.latestAll() });
  });

  // Current revision for the read-only dashboard.
  routes.get('/status', (c) =>
    c.json({ revision: revision.current() }),
  );

  return routes;
}
