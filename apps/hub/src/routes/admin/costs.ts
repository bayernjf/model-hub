import { Hono } from 'hono';
import {
  requireAdmin,
  type AppEnv,
} from '../../auth/middleware.js';
import type { HubConfig } from '../../config.js';
import type {
  CostAggregateRow,
  UsageRepository,
} from '../../repositories/reporting.js';

// Read-only cross-project cost dashboard (W7-4). Builtin spend is owner cost
// (cost_micros computed at report time from the assigned model's pricing);
// BYOK spend is the user's own money, so we only surface its volume, never a
// cost figure.

interface CostCell {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  quantity: number;
  cost_micros: number;
}

interface SourceSplit {
  builtin: CostCell;
  byok: CostCell;
}

function emptyCell(): CostCell {
  return { calls: 0, input_tokens: 0, output_tokens: 0, quantity: 0, cost_micros: 0 };
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
  cell.quantity += row.quantity;
  if (withCost) cell.cost_micros += row.cost_micros;
}

export function adminCostRoutes(
  config: HubConfig,
  usageRepo: UsageRepository,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  routes.get('/costs', (c) => {
    const rows = usageRepo.aggregate();

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
    });
  });

  return routes;
}
