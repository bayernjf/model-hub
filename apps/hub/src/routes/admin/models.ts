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
import {
  ModelRepository,
  ModelConflictError,
  PresetNotFoundError,
} from '../../repositories/models.js';
import type { ProviderRepository } from '../../repositories/providers.js';
import { SlidingWindowRateLimiter } from '../../rate-limit.js';
import { testProvider, testModel } from '../../connection-test.js';
import { PRESET_CATALOG } from '../../presets/index.js';
import type { RevisionService } from '../../revision.js';
import {
  ImportModelsSchema,
  ManualModelCreateSchema,
  ModelOverlayPatchSchema,
  firstIssue,
} from '../../model-schemas.js';

export function modelRoutes(
  config: HubConfig,
  db: DatabaseSync,
  repo: ModelRepository,
  providerRepo: ProviderRepository,
  rateLimiter: SlidingWindowRateLimiter,
  revision: RevisionService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  const actorOf = (c: { get: (k: 'session') => { username: string } | undefined }) =>
    c.get('session')?.username ?? 'unknown';

  // L1 provider connection test.
  routes.post('/providers/:id/test', requireOwner(), async (c) => {
    const providerId = c.req.param('id');
    const provider = providerRepo.get(providerId);
    if (!provider) return c.json({ error: { code: 'not_found' } }, 404);

    if (!rateLimiter.allow(clientIp(c))) {
      return c.json(
        { error: { code: 'rate_limited', hint: '每小时最多 20 次测试' } },
        429,
      );
    }

    const apiKey = providerRepo.revealKey(providerId);
    if (!apiKey) {
      return c.json({
        ok: false,
        latency_ms: 0,
        scope: 'provider',
        error: { code: 'unauthorized', hint: '尚未配置 API key' },
      });
    }

    const result = await testProvider({
      base_url: provider.base_url,
      api_key: apiKey,
      protocol: provider.protocol,
      billing_type: provider.billing_type,
      preset_id: provider.preset_id,
      models: repo.listByProvider(providerId),
    });

    writeAudit(db, {
      actor: actorOf(c),
      action: 'provider.test',
      targetType: 'provider',
      targetId: providerId,
      result: result.ok ? 'success' : 'failure',
      ip: clientIp(c),
    });

    return c.json(result);
  });

  // L2 single-model connection test. Pass ?deep=true to perform a paid
  // generation; the UI must confirm the cost before doing so.
  routes.post('/models/:id/test', requireOwner(), async (c) => {
    const modelId = c.req.param('id');
    const model = repo.get(modelId);
    if (!model) return c.json({ error: { code: 'not_found' } }, 404);

    if (!rateLimiter.allow(clientIp(c))) {
      return c.json(
        { error: { code: 'rate_limited', hint: '每小时最多 20 次测试' } },
        429,
      );
    }

    const provider = providerRepo.get(model.provider_id);
    if (!provider) return c.json({ error: { code: 'not_found' } }, 404);

    const deep = c.req.query('deep') === 'true';
    const apiKey = providerRepo.revealKey(provider.id);
    if (!apiKey) {
      repo.recordTestResult({
        model_id: modelId,
        deep,
        ok: false,
        latency_ms: 0,
        error_code: 'unauthorized',
      });
      return c.json({
        ok: false,
        latency_ms: 0,
        scope: 'model',
        error: { code: 'unauthorized', hint: '尚未配置 API key' },
      });
    }

    const result = await testModel({
      base_url: provider.base_url,
      api_key: apiKey,
      billing_type: provider.billing_type,
      model,
      deep,
    });
    repo.recordTestResult({
      model_id: modelId,
      deep,
      ok: result.ok,
      latency_ms: result.latency_ms,
      error_code: result.error?.code ?? null,
    });

    writeAudit(db, {
      actor: actorOf(c),
      action: 'model.test',
      targetType: 'model',
      targetId: modelId,
      result: result.ok ? 'success' : 'failure',
      ip: clientIp(c),
    });

    return c.json(result);
  });

  // Preset catalog (data only, no credentials).
  routes.get('/presets', (c) =>
    c.json({
      catalog_version: PRESET_CATALOG.catalog_version,
      sourcing_note: PRESET_CATALOG.sourcing_note,
      presets: PRESET_CATALOG.presets,
    }),
  );

  // Models under a provider.
  routes.get('/providers/:id/models', (c) =>
    c.json({ models: repo.listByProvider(c.req.param('id')) }),
  );

  // All models across providers (model page), with the newest persisted L2
  // test per model so badges survive a reload.
  routes.get('/models', (c) =>
    c.json({ models: repo.listAll(), last_tests: repo.latestTestResults() }),
  );

  // Batch-import preset models (disabled by default).
  routes.post(
    '/providers/:id/models/import',
    requireOwner(),
    async (c) => {
      const providerId = c.req.param('id');
      const parsed = ImportModelsSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return c.json(
          { error: { code: 'validation_error', message: firstIssue(parsed.error) } },
          400,
        );
      }
      try {
        const result = repo.importFromPreset(
          providerId,
          parsed.data.preset_provider_id,
          parsed.data.model_ids,
        );
        writeAudit(db, {
          actor: actorOf(c),
          action: 'model.import',
          targetType: 'provider',
          targetId: providerId,
          result: 'success',
          ip: clientIp(c),
        });
        revision.bump();
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof PresetNotFoundError) {
          return c.json(
            { error: { code: 'validation_error', message: err.message } },
            400,
          );
        }
        throw err;
      }
    },
  );

  // Manual model entry.
  routes.post('/providers/:id/models', requireOwner(), async (c) => {
    const providerId = c.req.param('id');
    const parsed = ManualModelCreateSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: { code: 'validation_error', message: firstIssue(parsed.error) } },
        400,
      );
    }
    try {
      const model = repo.createManual(providerId, parsed.data);
      writeAudit(db, {
        actor: actorOf(c),
        action: 'model.create',
        targetType: 'model',
        targetId: model.id,
        result: 'success',
        ip: clientIp(c),
      });
      revision.bump();
      return c.json({ model }, 201);
    } catch (err) {
      if (err instanceof ModelConflictError) {
        return c.json(
          { error: { code: 'validation_error', message: err.message } },
          400,
        );
      }
      throw err;
    }
  });

  // Owner overlay (strict allow-list).
  routes.patch('/models/:id', requireOwner(), async (c) => {
    const id = c.req.param('id');
    const parsed = ModelOverlayPatchSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: { code: 'validation_error', message: firstIssue(parsed.error) } },
        400,
      );
    }
    const model = repo.updateOverlay(id, parsed.data);
    if (!model) return c.json({ error: { code: 'not_found' } }, 404);
    writeAudit(db, {
      actor: actorOf(c),
      action: 'model.update',
      targetType: 'model',
      targetId: id,
      result: 'success',
      ip: clientIp(c),
    });
    revision.bump();
    return c.json({ model });
  });

  // Retire a model.
  routes.delete('/models/:id', requireOwner(), (c) => {
    const id = c.req.param('id');
    const ok = repo.delete(id);
    if (!ok) return c.json({ error: { code: 'not_found' } }, 404);
    writeAudit(db, {
      actor: actorOf(c),
      action: 'model.delete',
      targetType: 'model',
      targetId: id,
      result: 'success',
      ip: clientIp(c),
    });
    revision.bump();
    return c.json({ ok: true });
  });

  return routes;
}
