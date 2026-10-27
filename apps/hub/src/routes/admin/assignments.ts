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
import type { RevisionService } from '../../revision.js';
import {
  AssignmentValidationError,
  type AssignmentInput,
  type AssignmentRepository,
} from '../../repositories/assignments.js';

function isAssignmentInput(value: unknown): value is AssignmentInput {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { model_id?: unknown }).model_id === 'string';
}

export function assignmentRoutes(
  config: HubConfig,
  db: DatabaseSync,
  repo: AssignmentRepository,
  revision: RevisionService,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  // List assignments, optionally scoped to one project.
  routes.get('/', (c) => {
    const projectId = c.req.query('project');
    if (projectId) {
      return c.json({ assignments: repo.listByProject(projectId) });
    }
    return c.json({ assignments: repo.listAll() });
  });

  // Replace a project's full assignment set in one batch.
  routes.put('/', requireOwner(), async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      project_id?: unknown;
      assignments?: unknown;
    };
    if (
      typeof body.project_id !== 'string' ||
      !Array.isArray(body.assignments) ||
      !body.assignments.every(isAssignmentInput)
    ) {
      return c.json(
        { error: { code: 'validation_error', message: 'project_id and assignments[] required' } },
        400,
      );
    }

    try {
      const assignments = repo.replaceForProject(
        body.project_id,
        body.assignments,
      );
      writeAudit(db, {
        actor: c.get('session')?.username ?? 'unknown',
        action: 'assignment.update',
        targetType: 'project',
        targetId: body.project_id,
        result: 'success',
        ip: clientIp(c),
      });
      revision.bump();
      return c.json({ assignments });
    } catch (err) {
      if (err instanceof AssignmentValidationError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          400,
        );
      }
      throw err;
    }
  });

  return routes;
}
