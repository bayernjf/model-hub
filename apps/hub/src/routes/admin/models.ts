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
import { PRESET_CATALOG } from '../../presets/index.js';
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
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  const actorOf = (c: { get: (k: 'session') => { username: string } | undefined }) =>
    c.get('session')?.username ?? 'unknown';

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
    return c.json({ ok: true });
  });

  return routes;
}
