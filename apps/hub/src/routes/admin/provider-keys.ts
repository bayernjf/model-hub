import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { clientIp } from '../../auth/request.js';
import {
  requireAdmin,
  requireOwner,
  type AppEnv,
} from '../../auth/middleware.js';
import { writeAudit } from '../../audit.js';
import type { HubConfig } from '../../config.js';
import type { ProviderRepository } from '../../repositories/providers.js';
import {
  LastActiveKeyError,
  ProviderKeyRepository,
} from '../../repositories/provider-keys.js';
import type { RevisionService } from '../../revision.js';
import { normalizePolicy, policyJson } from '../../cooldown-policy.js';
import { testProvider } from '../../connection-test.js';

export function providerKeyRoutes(
  config: HubConfig,
  db: DatabaseSync,
  providers: ProviderRepository,
  keys: ProviderKeyRepository,
  revision: RevisionService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  // GET /api/admin/providers/:id/keys
  routes.get('/:id/keys', (c) => {
    const id = c.req.param('id');
    if (!providers.get(id)) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json({ keys: keys.listForProvider(id) });
  });

  // POST /api/admin/providers/:id/keys { label, api_key }
  routes.post('/:id/keys', requireOwner(), async (c) => {
    const id = c.req.param('id');
    if (!providers.get(id)) return c.json({ error: { code: 'not_found' } }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      label?: unknown;
      api_key?: unknown;
    } | null;
    const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : '';
    if (!apiKey) {
      return c.json({ error: { code: 'validation_error', message: 'api_key is required' } }, 400);
    }
    const label = typeof body?.label === 'string' ? body.label.slice(0, 80) : '';
    const view = keys.add(id, label, apiKey);
    writeAudit(db, {
      actor: c.get('session')?.username ?? 'unknown',
      action: 'provider_key.create',
      targetType: 'provider_key',
      targetId: view.id,
      result: 'success',
      ip: clientIp(c),
    });
    revision.bump();
    return c.json({ key: view }, 201);
  });

  // PATCH .../keys/:keyId { is_active?, label? }
  routes.patch('/:id/keys/:keyId', requireOwner(), async (c) => {
    const keyId = c.req.param('keyId');
    const body = (await c.req.json().catch(() => null)) as {
      is_active?: unknown;
      label?: unknown;
    } | null;
    let view = keys.get(keyId);
    if (!view || view.provider_id !== c.req.param('id')) {
      return c.json({ error: { code: 'not_found' } }, 404);
    }
    try {
      if (typeof body?.is_active === 'boolean') {
        view = keys.setActive(keyId, body.is_active);
      }
      if (typeof body?.label === 'string') {
        view = keys.updateLabel(keyId, body.label.slice(0, 80));
      }
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'provider_key.update',
        targetType: 'provider_key',
        targetId: keyId,
        result: 'success',
        ip: clientIp(c),
      });
      revision.bump();
      return c.json({ key: view });
    } catch (err) {
      if (err instanceof LastActiveKeyError) {
        return c.json({ error: { code: 'last_active_key', message: err.message } }, 409);
      }
      throw err;
    }
  });

  // POST .../keys/:keyId/test — L1 connection test for one pool key.
  routes.post('/:id/keys/:keyId/test', requireOwner(), async (c) => {
    const id = c.req.param('id');
    const keyId = c.req.param('keyId');
    const provider = providers.get(id);
    if (!provider) return c.json({ error: { code: 'not_found' } }, 404);
    const owned = keys.get(keyId);
    if (!owned || owned.provider_id !== id) {
      return c.json({ error: { code: 'not_found' } }, 404);
    }
    const apiKey = keys.revealKey(keyId);
    if (!apiKey) {
      return c.json({
        ok: false,
        latency_ms: 0,
        scope: 'key',
        error: { code: 'unauthorized', hint: '该密钥不可用' },
      });
    }
    const result = await testProvider({
      base_url: provider.base_url,
      api_key: apiKey,
      protocol: provider.protocol,
      billing_type: provider.billing_type,
      preset_id: provider.preset_id,
    });
    writeAudit(db, {
      actor: c.get('session')?.username ?? 'unknown',
      action: 'provider_key.test',
      targetType: 'provider_key',
      targetId: keyId,
      result: result.ok ? 'success' : 'failure',
      ip: clientIp(c),
    });
    return c.json({ ...result, scope: 'key' });
  });

  // POST .../keys/reorder { ordered_ids: string[] }
  routes.post('/:id/keys/reorder', requireOwner(), async (c) => {
    const id = c.req.param('id');
    if (!providers.get(id)) return c.json({ error: { code: 'not_found' } }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      ordered_ids?: unknown;
    } | null;
    if (!Array.isArray(body?.ordered_ids)) {
      return c.json({ error: { code: 'validation_error', message: 'ordered_ids must be an array' } }, 400);
    }
    try {
      const ordered = keys.reorder(id, body!.ordered_ids.map(String));
      revision.bump();
      return c.json({ keys: ordered });
    } catch (err) {
      return c.json({ error: { code: 'validation_error', message: (err as Error).message } }, 400);
    }
  });

  // POST .../keys/:keyId/recover
  routes.post('/:id/keys/:keyId/recover', requireOwner(), (c) => {
    const keyId = c.req.param('keyId');
    const view = keys.get(keyId);
    if (!view || view.provider_id !== c.req.param('id')) {
      return c.json({ error: { code: 'not_found' } }, 404);
    }
    const recovered = keys.recover(keyId);
    writeAudit(db, {
      actor: c.get('session')?.username ?? 'unknown',
      action: 'provider_key.recover',
      targetType: 'provider_key',
      targetId: keyId,
      result: 'success',
      ip: clientIp(c),
    });
    revision.bump();
    return c.json({ key: recovered });
  });

  // DELETE .../keys/:keyId (refuses the last active key)
  routes.delete('/:id/keys/:keyId', requireOwner(), (c) => {
    const keyId = c.req.param('keyId');
    const view = keys.get(keyId);
    if (!view || view.provider_id !== c.req.param('id')) {
      return c.json({ error: { code: 'not_found' } }, 404);
    }
    try {
      keys.delete(keyId);
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'provider_key.delete',
        targetType: 'provider_key',
        targetId: keyId,
        result: 'success',
        ip: clientIp(c),
      });
      revision.bump();
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof LastActiveKeyError) {
        return c.json({ error: { code: 'last_active_key', message: err.message } }, 409);
      }
      throw err;
    }
  });

  // PUT /api/admin/providers/:id/cooldown-policy
  routes.put('/:id/cooldown-policy', requireOwner(), async (c) => {
    const id = c.req.param('id');
    if (!providers.get(id)) return c.json({ error: { code: 'not_found' } }, 404);
    const body = await c.req.json().catch(() => null);
    const policy = normalizePolicy(body);
    const view = providers.setCooldownPolicy(id, policyJson(policy));
    writeAudit(db, {
      actor: c.get('session')?.username ?? 'unknown',
      action: 'provider.cooldown_policy',
      targetType: 'provider',
      targetId: id,
      result: 'success',
      ip: clientIp(c),
    });
    revision.bump();
    return c.json({ provider: view });
  });

  return routes;
}
