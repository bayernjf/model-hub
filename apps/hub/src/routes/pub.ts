import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ProjectRepository } from '../repositories/projects.js';
import type { ProjectionService } from '../projection.js';
import type { RevisionService } from '../revision.js';

function bearerToken(c: Context): string | null {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

export function pubRoutes(
  projectRepo: ProjectRepository,
  projection: ProjectionService,
  revision: RevisionService,
): Hono {
  const routes = new Hono();

  // Project-facing catalog pull.
  routes.get('/pub/v1/models', (c) => {
    const token = bearerToken(c);
    if (!token) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }

    const auth = projectRepo.authenticateToken(token);
    if (!auth) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }

    const currentRevision = revision.current();
    const etag = `"${currentRevision}"`;
    if (c.req.header('If-None-Match') === etag) {
      c.header('ETag', etag);
      return c.body(null, 304);
    }

    const models = projection.projectFor(auth.project.id);

    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    return c.json({
      project: auth.project.slug,
      revision: currentRevision,
      fetched_at: new Date().toISOString(),
      models,
    });
  });

  return routes;
}
