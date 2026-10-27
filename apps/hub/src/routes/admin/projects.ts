import type { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { clientIp } from '../../auth/request.js';
import {
  requireAdmin,
  requireOwner,
  type AppEnv,
} from '../../auth/middleware.js';
import { writeAudit } from '../../audit.js';
import type { HubConfig } from '../../config.js';
import {
  SlugConflictError,
  type ProjectRepository,
} from '../../repositories/projects.js';
import {
  validateProjectCreate,
  validateProjectUpdate,
  ValidationError,
} from '../../validation.js';

function validationResponse(c: Context, err: ValidationError) {
  return c.json(
    {
      error: {
        code: 'validation_error',
        field: err.field,
        message: err.message,
      },
    },
    400,
  );
}

export function projectRoutes(
  config: HubConfig,
  db: DatabaseSync,
  repo: ProjectRepository,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  routes.get('/', (c) => c.json({ projects: repo.list() }));

  routes.get('/:id', (c) => {
    const project = repo.get(c.req.param('id'));
    if (!project) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json({ project });
  });

  routes.post('/', requireOwner(), async (c) => {
    try {
      const input = validateProjectCreate(
        await c.req.json().catch(() => null),
      );
      const project = repo.create(input);
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'project.create',
        targetType: 'project',
        targetId: project.id,
        result: 'success',
        ip: clientIp(c),
      });
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return validationResponse(c, err);
      if (err instanceof SlugConflictError) {
        return c.json({ error: { code: 'slug_conflict' } }, 409);
      }
      throw err;
    }
  });

  routes.patch('/:id', requireOwner(), async (c) => {
    try {
      const patch = validateProjectUpdate(
        await c.req.json().catch(() => null),
      );
      const project = repo.update(c.req.param('id'), patch);
      if (!project) return c.json({ error: { code: 'not_found' } }, 404);
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'project.update',
        targetType: 'project',
        targetId: project.id,
        result: 'success',
        ip: clientIp(c),
      });
      return c.json({ project });
    } catch (err) {
      if (err instanceof ValidationError) return validationResponse(c, err);
      throw err;
    }
  });

  routes.delete('/:id', requireOwner(), (c) => {
    const id = c.req.param('id');
    const ok = repo.delete(id);
    if (!ok) return c.json({ error: { code: 'not_found' } }, 404);
    writeAudit(db, {
      actor: c.get('session')?.username ?? 'unknown',
      action: 'project.delete',
      targetType: 'project',
      targetId: id,
      result: 'success',
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  // Mint (or rotate) a project token. The plaintext token is returned in this
  // response exactly once; only the hash is stored.
  routes.post('/:id/rotate-token', requireOwner(), (c) => {
    const result = repo.rotateToken(c.req.param('id'));
    if (!result) return c.json({ error: { code: 'not_found' } }, 404);
    writeAudit(db, {
      actor: c.get('session')?.username ?? 'unknown',
      action: 'project.rotate_token',
      targetType: 'token',
      targetId: result.view.id,
      result: 'success',
      ip: clientIp(c),
    });
    return c.json(
      { token: result.token, token_view: result.view },
      201,
    );
  });

  // Enable or disable a token (revocation).
  routes.patch('/tokens/:tokenId', requireOwner(), async (c) => {
    let body: { enabled?: unknown };
    try {
      body = (await c.req.json()) as { enabled?: unknown };
    } catch {
      body = {};
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json(
        { error: { code: 'validation_error', field: 'enabled' } },
        400,
      );
    }
    const ok = repo.setTokenEnabled(c.req.param('tokenId'), body.enabled);
    if (!ok) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json({ ok: true });
  });

  return routes;
}
