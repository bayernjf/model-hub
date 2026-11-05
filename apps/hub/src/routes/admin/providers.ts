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
import { isMasked } from '../../crypto/mask.js';
import type { ProviderKeyRepository } from '../../repositories/provider-keys.js';
import type {
  ProviderRepository,
  ProviderView,
} from '../../repositories/providers.js';
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
  keys: ProviderKeyRepository,
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
      const id = c.req.param('id');
      let provider: ProviderView | null;
      // A real (non-mask, non-empty) api_key must land in the key pool too,
      // otherwise the projection keeps serving the old credential.
      const newKey = patch.api_key;
      if (typeof newKey === 'string' && newKey !== '' && !isMasked(newKey)) {
        // One transaction so the legacy column and the pool never disagree.
        db.exec('BEGIN');
        try {
          provider = repo.update(id, patch);
          if (provider) keys.syncPrimaryKey(id, newKey);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } else {
        provider = repo.update(id, patch);
      }

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
