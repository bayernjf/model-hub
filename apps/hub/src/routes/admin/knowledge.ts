import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  requireAdmin,
  requireOwner,
  type AppEnv,
} from '../../auth/middleware.js';
import type { HubConfig } from '../../config.js';
import type { ProjectRepository } from '../../repositories/projects.js';
import type { KnowledgeService } from '../../knowledge/service.js';
import {
  AdminKnowledgeIngestSchema,
  AdminKnowledgeQuerySchema,
} from '../../knowledge/schemas.js';
import { handleKnowledgeError } from '../knowledge.js';
import { firstZodIssue } from '../../reporting-schemas.js';

// Admin-console knowledge endpoints (W3-4). Same service as the
// project-token API, but the owner project is chosen explicitly and
// session auth applies: operator may read (documents, query); owner is
// required for writes (ingest, delete).

function validationResponse(c: Context, message: string): Response {
  return c.json({ error: { code: 'validation_error', message } }, 400);
}

export function adminKnowledgeRoutes(
  config: HubConfig,
  projectRepo: ProjectRepository,
  knowledge: KnowledgeService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  // The owner must name an existing project; anything else is a 404 so the
  // console can tell a stale dropdown from a real error.
  const resolveOwner = (raw: string | undefined | null): string | null => {
    if (!raw) return null;
    const project = projectRepo.get(raw);
    return project ? project.id : null;
  };

  routes.get('/knowledge/documents', (c) => {
    const owner = resolveOwner(c.req.query('owner'));
    if (!owner) {
      return c.json(
        { error: { code: 'not_found', message: 'unknown owner project' } },
        404,
      );
    }
    return c.json({ documents: knowledge.listDocuments(owner) });
  });

  routes.post('/knowledge/ingest', requireOwner(), async (c) => {
    const parsed = AdminKnowledgeIngestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return validationResponse(c, firstZodIssue(parsed.error));
    }
    const body = parsed.data;
    const owner = resolveOwner(body.owner);
    if (!owner) {
      return c.json(
        { error: { code: 'not_found', message: 'unknown owner project' } },
        404,
      );
    }
    if (body.title.toLowerCase().endsWith('.pdf')) {
      return c.json(
        {
          error: {
            code: 'unsupported_media_type',
            message:
              'PDF ingestion is not supported yet; paste the text or upload .md/.txt',
          },
        },
        422,
      );
    }
    try {
      const result = await knowledge.ingest(owner, {
        title: body.title,
        text: body.text,
        mime: body.mime,
        source: body.source ?? 'console',
        chunkSize: body.chunk_size,
        chunkOverlap: body.chunk_overlap,
      });
      return c.json(result, 201);
    } catch (err) {
      return handleKnowledgeError(c, err);
    }
  });

  routes.post('/knowledge/query', async (c) => {
    const parsed = AdminKnowledgeQuerySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return validationResponse(c, firstZodIssue(parsed.error));
    }
    const owner = resolveOwner(parsed.data.owner);
    if (!owner) {
      return c.json(
        { error: { code: 'not_found', message: 'unknown owner project' } },
        404,
      );
    }
    try {
      const outcome = await knowledge.query(owner, {
        query: parsed.data.query,
        topK: parsed.data.top_k,
        rerank: parsed.data.rerank,
      });
      return c.json(outcome);
    } catch (err) {
      return handleKnowledgeError(c, err);
    }
  });

  routes.delete('/knowledge/documents/:id', requireOwner(), (c) => {
    const owner = resolveOwner(c.req.query('owner'));
    if (!owner) {
      return c.json(
        { error: { code: 'not_found', message: 'unknown owner project' } },
        404,
      );
    }
    const deleted = knowledge.deleteDocument(owner, c.req.param('id'));
    if (!deleted) {
      return c.json({ error: { code: 'not_found' } }, 404);
    }
    return c.json({ deleted: true });
  });

  return routes;
}
