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
import type { ProviderRepository } from '../../repositories/providers.js';
import type { RevisionService } from '../../revision.js';
import {
  validateProviderCreate,
  validateProviderUpdate,
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

export function providerRoutes(
  config: HubConfig,
  db: DatabaseSync,
  repo: ProviderRepository,
  revision: RevisionService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  routes.get('/', (c) => c.json({ providers: repo.list() }));

  routes.get('/:id', (c) => {
    const provider = repo.get(c.req.param('id'));
    if (!provider) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json({ provider });
  });

  routes.post('/', requireOwner(), async (c) => {
    try {
      const input = validateProviderCreate(
        await c.req.json().catch(() => null),
      );
      const provider = repo.create(input);
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'provider.create',
        targetType: 'provider',
        targetId: provider.id,
        result: 'success',
        ip: clientIp(c),
      });
      revision.bump();
      return c.json({ provider }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return validationResponse(c, err);
      throw err;
    }
  });

  routes.patch('/:id', requireOwner(), async (c) => {
    try {
      const patch = validateProviderUpdate(
        await c.req.json().catch(() => null),
      );
      const provider = repo.update(c.req.param('id'), patch);
      if (!provider) return c.json({ error: { code: 'not_found' } }, 404);
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'provider.update',
        targetType: 'provider',
        targetId: provider.id,
        result: 'success',
        ip: clientIp(c),
      });
      revision.bump();
      return c.json({ provider });
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
      action: 'provider.delete',
      targetType: 'provider',
      targetId: id,
      result: 'success',
      ip: clientIp(c),
    });
    revision.bump();
    return c.json({ ok: true });
  });

  return routes;
}
