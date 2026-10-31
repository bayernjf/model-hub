import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SlidingWindowRateLimiter } from '../rate-limit.js';
import {
  EmbeddingError,
  KnowledgeNotConfiguredError,
  type KnowledgeService,
} from '../knowledge/service.js';
import {
  KnowledgeIngestSchema,
  KnowledgeQuerySchema,
} from '../knowledge/schemas.js';
import { ValidationError } from '../validation.js';
import { firstZodIssue } from '../reporting-schemas.js';

// Project-facing knowledge API (PRD F3 FR3-3/FR3-5). Bearer project token
// auth reuses the same surface as /pub/v1/*; the authenticated project is
// the document owner, so every read and write is owner-scoped.

type KnowledgeEnv = {
  Variables: {
    owner: string;
  };
};

function bearerToken(c: Context): string | null {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

export interface KnowledgeRouteDeps {
  projectRepo: ProjectRepository;
  knowledge: KnowledgeService;
  /** Per-project ingest budget (embedding spend guard). */
  ingestLimiter: SlidingWindowRateLimiter;
  /** Per-project query budget (embedding spend guard). */
  queryLimiter: SlidingWindowRateLimiter;
}

// Map service errors to API responses; unknown errors rethrow into the
// app-level 500 handler.
function handleError(c: Context, err: unknown): Response {
  if (err instanceof KnowledgeNotConfiguredError) {
    return c.json(
      { error: { code: 'knowledge_not_configured', message: err.message } },
      503,
    );
  }
  if (err instanceof EmbeddingError) {
    return c.json(
      { error: { code: 'embedding_failed', message: err.message } },
      502,
    );
  }
  if (err instanceof ValidationError) {
    return c.json(
      { error: { code: 'validation_error', field: err.field, message: err.message } },
      400,
    );
  }
  if (err instanceof RangeError) {
    return c.json(
      { error: { code: 'validation_error', message: err.message } },
      400,
    );
  }
  throw err;
}

export function knowledgeRoutes(deps: KnowledgeRouteDeps): Hono<KnowledgeEnv> {
  const { projectRepo, knowledge, ingestLimiter, queryLimiter } = deps;
  const routes = new Hono<KnowledgeEnv>();

  routes.use('/v1/knowledge/*', async (c, next) => {
    const token = bearerToken(c);
    const auth = token ? projectRepo.authenticateToken(token) : null;
    if (!auth) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }
    c.set('owner', auth.project.id);
    await next();
  });

  routes.post('/v1/knowledge/ingest', async (c) => {
    const owner = c.get('owner');
    if (!ingestLimiter.allow(owner)) {
      return c.json({ error: { code: 'rate_limited' } }, 429);
    }
    const parsed = KnowledgeIngestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: { code: 'validation_error', message: firstZodIssue(parsed.error) } },
        400,
      );
    }
    const body = parsed.data;
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
        source: body.source ?? 'api',
        chunkSize: body.chunk_size,
        chunkOverlap: body.chunk_overlap,
      });
      return c.json(result, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  routes.post('/v1/knowledge/query', async (c) => {
    const owner = c.get('owner');
    if (!queryLimiter.allow(owner)) {
      return c.json({ error: { code: 'rate_limited' } }, 429);
    }
    const parsed = KnowledgeQuerySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: { code: 'validation_error', message: firstZodIssue(parsed.error) } },
        400,
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
      return handleError(c, err);
    }
  });

  routes.get('/v1/knowledge/documents', (c) => {
    const owner = c.get('owner');
    return c.json({ documents: knowledge.listDocuments(owner) });
  });

  routes.delete('/v1/knowledge/documents/:id', (c) => {
    const owner = c.get('owner');
    const id = c.req.param('id');
    const deleted = knowledge.deleteDocument(owner, id);
    if (!deleted) {
      return c.json({ error: { code: 'not_found' } }, 404);
    }
    return c.json({ deleted: true });
  });

  return routes;
}
