import { Hono, type Context } from 'hono';
import {
  requireAdmin,
  type AppEnv,
} from '../../auth/middleware.js';
import type { HubConfig } from '../../config.js';
import type { AssignmentRepository } from '../../repositories/assignments.js';
import type { ModelRepository } from '../../repositories/models.js';
import type { ProjectRepository } from '../../repositories/projects.js';
import type {
  CostAggregateRow,
  CostAggregateWindow,
  UsageRepository,
} from '../../repositories/reporting.js';
import { ValidationError } from '../../validation.js';

// Read-only cross-project cost dashboard (W7-4). Builtin spend is owner cost
// (cost_micros computed at report time from the assigned model's pricing);
// BYOK spend is the user's own money, so we only surface its volume, never a
// cost figure. W5-3 adds the per-assignment budget watermark (today's UTC
// builtin spend vs daily_budget_micros) for budgeted assignments.

interface CostCell {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  quantity: number;
  cost_micros: number;
}

interface SourceSplit {
  builtin: CostCell;
  byok: CostCell;
}

function emptyCell(): CostCell {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    quantity: 0,
    cost_micros: 0,
  };
}

function emptySplit(): SourceSplit {
  return { builtin: emptyCell(), byok: emptyCell() };
}

function splitOf(map: Map<string, SourceSplit>, key: string): SourceSplit {
  let cell = map.get(key);
  if (!cell) {
    cell = emptySplit();
    map.set(key, cell);
  }
  return cell;
}

function addTo(cell: CostCell, row: CostAggregateRow, withCost: boolean): void {
  cell.calls += row.calls;
  cell.input_tokens += row.input_tokens;
  cell.output_tokens += row.output_tokens;
  cell.reasoning_tokens += row.reasoning_tokens;
  cell.cache_read_tokens += row.cache_read_tokens;
  cell.quantity += row.quantity;
  if (withCost) cell.cost_micros += row.cost_micros;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Accepts "YYYY-MM-DD" (interpreted as a UTC day) or any parseable ISO-8601
// timestamp. Everything is normalized to a UTC "…Z" string so it compares
// lexicographically against the stored ts values. `endOfDay` extends a
// date-only upper bound to the last millisecond of that day.
function parseWindowBound(
  raw: string,
  field: string,
  endOfDay: boolean,
): string {
  const value = raw.trim();
  if (DATE_ONLY_RE.test(value)) {
    return endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(field, `${field} must be an ISO-8601 date`);
  }
  return parsed.toISOString();
}

function parseWindow(
  query: Record<string, string>,
): CostAggregateWindow | undefined {
  const fromRaw = query['from'];
  const toRaw = query['to'];
  if (!fromRaw && !toRaw) return undefined;
  const from = fromRaw ? parseWindowBound(fromRaw, 'from', false) : undefined;
  const to = toRaw ? parseWindowBound(toRaw, 'to', true) : undefined;
  if (from && to && from > to) {
    throw new ValidationError('from', 'from must not be after to');
  }
  const window: CostAggregateWindow = {};
  if (from) window.from = from;
  if (to) window.to = to;
  return window;
}

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

export interface CostsRepoDeps {
  assignmentRepo: AssignmentRepository;
  modelRepo: ModelRepository;
  projectRepo: ProjectRepository;
}

// Budget watermark rows: one per assignment with a configured daily budget.
// Spent is today's UTC builtin cost for the assignment regardless of the
// request window — a watermark is a "right now" reading, not a historical one.
export function budgetWatermarkRows(
  deps: CostsRepoDeps,
  usageRepo: UsageRepository,
): Array<{
  project: string;
  assignment_id: string;
  alias: string | null;
  role: string;
  model: string;
  spent_micros: number;
  daily_budget_micros: number;
  percent: number | null;
}> {
  const rows: Array<{
    project: string;
    assignment_id: string;
    alias: string | null;
    role: string;
    model: string;
    spent_micros: number;
    daily_budget_micros: number;
    percent: number | null;
  }> = [];
  const projectSlugs = new Map<string, string>();
  const projectName = (id: string): string => {
    let slug = projectSlugs.get(id);
    if (!slug) {
      slug = deps.projectRepo.get(id)?.slug ?? id;
      projectSlugs.set(id, slug);
    }
    return slug;
  };

  // One aggregation for all projects; keyed by "projectId/assignmentId".
  const spentToday = new Map<string, number>();
  for (const row of usageRepo.spendTodayByAssignment()) {
    if (row.assignment_id) {
      spentToday.set(`${row.project_id}/${row.assignment_id}`, row.cost_micros);
    }
  }

  for (const assignment of deps.assignmentRepo.listAll()) {
    const budget = assignment.daily_budget_micros;
    if (budget === null) continue;
    const model = deps.modelRepo.get(assignment.model_id);
    const spent =
      spentToday.get(`${assignment.project_id}/${assignment.id}`) ?? 0;
    rows.push({
      project: projectName(assignment.project_id),
      assignment_id: assignment.id,
      alias: assignment.alias,
      role: assignment.role,
      model: model?.model ?? assignment.model_id,
      spent_micros: spent,
      daily_budget_micros: budget,
      percent:
        budget > 0 ? Math.round((spent / budget) * 10000) / 100 : spent > 0 ? null : 0,
    });
  }
  return rows;
}

export function adminCostRoutes(
  config: HubConfig,
  usageRepo: UsageRepository,
  repos: CostsRepoDeps,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  routes.get('/costs', (c) => {
    let window: CostAggregateWindow | undefined;
    try {
      window = parseWindow(c.req.query());
    } catch (err) {
      if (err instanceof ValidationError) return validationResponse(c, err);
      throw err;
    }
    const rows = usageRepo.aggregate(window);

    const byProject = new Map<string, SourceSplit>();
    const byModel = new Map<string, SourceSplit>();
    const byDay = new Map<string, SourceSplit>();
    const totals = emptySplit();

    for (const row of rows) {
      const withCost = row.billing_source !== 'byok';
      addTo(
        splitOf(byProject, row.project)[row.billing_source === 'byok' ? 'byok' : 'builtin'],
        row,
        withCost,
      );
      addTo(
        splitOf(byDay, row.day)[row.billing_source === 'byok' ? 'byok' : 'builtin'],
        row,
        withCost,
      );
      addTo(
        splitOf(byModel, `${row.project} / ${row.model}`)[
          row.billing_source === 'byok' ? 'byok' : 'builtin'
        ],
        row,
        withCost,
      );
      addTo(
        totals[row.billing_source === 'byok' ? 'byok' : 'builtin'],
        row,
        withCost,
      );
    }

    return c.json({
      totals,
      by_project: [...byProject.entries()].map(([project, s]) => ({
        project,
        ...s,
      })),
      by_day: [...byDay.entries()].map(([day, s]) => ({ day, ...s })),
      by_model: [...byModel.entries()].map(([key, s]) => {
        const [project, model] = key.split(' / ');
        return { project, model, ...s };
      }),
      budgets: budgetWatermarkRows(repos, usageRepo),
    });
  });

  return routes;
}
