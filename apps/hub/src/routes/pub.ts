import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ProjectRepository } from '../repositories/projects.js';
import type { ModelRepository } from '../repositories/models.js';
import type { AssignmentRepository } from '../repositories/assignments.js';
import {
  BudgetAlertRepository,
  HealthCheckRepository,
  UsageRepository,
} from '../repositories/reporting.js';
import type { ProjectionService } from '../projection.js';
import type { RevisionService } from '../revision.js';
import {
  evaluateBudgetWatermarks,
  type BudgetAlertWebhookConfig,
} from '../budget-alerts.js';
import { computeCostMicros } from '../cost.js';
import {
  HealthCheckReportSchema,
  UsageReportSchema,
  firstZodIssue,
} from '../reporting-schemas.js';

function bearerToken(c: Context): string | null {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

export interface PubDeps {
  projectRepo: ProjectRepository;
  modelRepo: ModelRepository;
  assignmentRepo: AssignmentRepository;
  usageRepo: UsageRepository;
  healthRepo: HealthCheckRepository;
  alertRepo: BudgetAlertRepository;
  budgetAlertConfig: BudgetAlertWebhookConfig;
  budgetAlertFetch?: typeof fetch;
  projection: ProjectionService;
  revision: RevisionService;
}

export function pubRoutes(deps: PubDeps): Hono {
  const {
    projectRepo,
    modelRepo,
    assignmentRepo,
    usageRepo,
    healthRepo,
    alertRepo,
    budgetAlertConfig,
    budgetAlertFetch,
    projection,
    revision,
  } = deps;
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

  // Per-assignment budget readout for the current UTC day (W5-1). Spent
  // builtin cost_micros per assignment against its daily budget; BYOK spend
  // never counts (cost_micros stays null for user-key traffic). The readout
  // is eventually consistent: it reflects reports accepted by the hub so far.
  routes.get('/pub/v1/usage/summary', (c) => {
    const token = bearerToken(c);
    if (!token) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }
    const auth = projectRepo.authenticateToken(token);
    if (!auth) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }

    const spends = usageRepo.spendTodayByAssignment(auth.project.id);
    const spendByAssignment = new Map<string, number>();
    let totalToday = 0;
    for (const row of spends) {
      totalToday += row.cost_micros;
      if (row.assignment_id) spendByAssignment.set(row.assignment_id, row.cost_micros);
    }

    let matched = 0;
    const models = assignmentRepo.listByProject(auth.project.id).map((a) => {
      const model = modelRepo.get(a.model_id);
      const spent = spendByAssignment.get(a.id) ?? 0;
      matched += spent;
      const budget = a.daily_budget_micros;
      return {
        assignment_id: a.id,
        alias: a.alias,
        role: a.role,
        model: model?.model ?? a.model_id,
        spent_micros: spent,
        daily_budget_micros: budget,
        percent:
          budget !== null && budget > 0
            ? Math.round((spent / budget) * 10000) / 100
            : null,
      };
    });

    return c.json({
      project: auth.project.slug,
      day: new Date().toISOString().slice(0, 10),
      generated_at: new Date().toISOString(),
      models,
      // Builtin spend of the day not attributable to a current assignment
      // (rows reported without an assignment, or one since replaced).
      unassigned_spent_micros: totalToday - matched,
    });
  });

  // Usage reporting. Append-only; failures still record with zero units.
  routes.post('/pub/v1/usage', async (c) => {
    const token = bearerToken(c);
    if (!token) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }
    const auth = projectRepo.authenticateToken(token);
    if (!auth) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }

    const parsed = UsageReportSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: { code: 'validation_error', message: firstZodIssue(parsed.error) } },
        400,
      );
    }
    const r = parsed.data;

    // Verify the assignment belongs to this project when supplied.
    let assignmentValid = false;
    let assignmentForSpend: string | null = null;
    let modelForCost: ReturnType<ModelRepository['get']> = null;
    if (r.assignment_id) {
      const assignment = assignmentRepo
        .listByProject(auth.project.id)
        .find((a) => a.id === r.assignment_id);
      if (assignment) {
        assignmentValid = true;
        assignmentForSpend = assignment.id;
        modelForCost = modelRepo.get(assignment.model_id);
      }
    }

    let costMicros: number | null = null;
    if (r.billing_source === 'builtin' && modelForCost) {
      costMicros = computeCostMicros(
        modelForCost.pricing,
        {
          input_tokens: r.input_tokens ?? 0,
          output_tokens: r.output_tokens ?? 0,
          cache_read_tokens: r.cache_read_tokens ?? 0,
          quantity: r.quantity ?? null,
        },
        modelForCost.modalities,
      );
    }

    usageRepo.append({
      project_id: auth.project.id,
      feature: r.feature,
      billing_source: r.billing_source,
      billing_type: r.billing_type ?? null,
      provider: r.provider,
      model: r.model,
      assignment_id: assignmentValid ? r.assignment_id ?? null : null,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      cache_read_tokens: r.cache_read_tokens ?? 0,
      reasoning_tokens: r.reasoning_tokens ?? null,
      quantity: r.quantity ?? null,
      http_status: r.http_status,
      cached: r.cached,
      cost_micros: costMicros,
      degraded: r.degraded ?? false,
      ts: r.ts,
    });

    // Budget watermark evaluation (FR6-3): only builtin reports grow owner
    // spend, and only the assignment that just received spend can cross a
    // threshold. Fire-and-forget; never blocks or fails the report.
    if (costMicros !== null && assignmentForSpend) {
      evaluateBudgetWatermarks(
        {
          config: budgetAlertConfig,
          assignmentRepo,
          modelRepo,
          usageRepo,
          alertRepo,
          ...(budgetAlertFetch ? { fetchImpl: budgetAlertFetch } : {}),
        },
        {
          projectId: auth.project.id,
          projectSlug: auth.project.slug,
          assignmentId: assignmentForSpend,
        },
      );
    }

    // Never block the caller's workflow on reporting.
    return c.json({ accepted: true });
  });

  // L3/L4 health reporting.
  routes.post('/pub/v1/health-checks', async (c) => {
    const token = bearerToken(c);
    if (!token) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }
    const auth = projectRepo.authenticateToken(token);
    if (!auth) {
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }

    const parsed = HealthCheckReportSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: { code: 'validation_error', message: firstZodIssue(parsed.error) } },
        400,
      );
    }
    const r = parsed.data;

    let assignmentValid = false;
    if (r.assignment_id) {
      assignmentValid = assignmentRepo
        .listByProject(auth.project.id)
        .some((a) => a.id === r.assignment_id);
    }

    healthRepo.record({
      project_id: auth.project.id,
      assignment_id: assignmentValid ? r.assignment_id ?? null : null,
      alias: r.alias ?? null,
      level: r.level,
      ok: r.ok,
      latency_ms: r.latency_ms,
      error_code: r.error?.code ?? null,
      error_detail: r.error?.detail ?? null,
      error_hint: r.error?.hint ?? null,
      ts: r.ts,
    });

    return c.json({ accepted: true });
  });

  return routes;
}
