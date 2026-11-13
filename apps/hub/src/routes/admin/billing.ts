import { Hono, type Context } from 'hono';
import { requireAdmin, type AppEnv } from '../../auth/middleware.js';
import { buildStatement, periodBounds } from '../../billing.js';
import { freezeStatement, ReconciliationError } from '../../billing-freeze.js';
import type { HubConfig } from '../../config.js';
import type { BillingPeriodRepository } from '../../repositories/billing-periods.js';
import type { CostAggregateWindow, UsageRepository } from '../../repositories/reporting.js';
import { ValidationError } from '../../validation.js';

// Read-only billing statement per UTC month (T-B1-02).
//
// Deliberately a view over usage_events, not a new table: a period becomes a
// bill only when it is frozen for accounting, and that step (T-B1-04) needs a
// decision first. Until then the statement is reproducible on demand, which is
// the property a re-checkable bill actually needs.

function validationResponse(c: Context, err: ValidationError) {
  return c.json({ error: { code: 'validation_error', field: err.field, message: err.message } }, 400);
}

export function adminBillingRoutes(
  config: HubConfig,
  usageRepo: UsageRepository,
  billingPeriodRepo: BillingPeriodRepository,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  routes.get('/billing', (c) => {
    const raw = c.req.query('period')?.trim();
    // Default to the current UTC month: "what have we run up so far" is the
    // question people actually ask, and the response states the period it used.
    const period = raw && raw.length > 0 ? raw : new Date().toISOString().slice(0, 7);

    let window: CostAggregateWindow;
    try {
      const bounds = periodBounds(period);
      window = { from: bounds.from, to: bounds.to };
    } catch (error) {
      if (error instanceof ValidationError) return validationResponse(c, error);
      throw error;
    }

    const rows = usageRepo.aggregate(window);
    // Counted separately: the aggregate joins on projects, so these rows are
    // absent from it. Without this the statement silently under-reports.
    return c.json(buildStatement(rows, period, usageRepo.unattributedRows(window)));
  });

  // Freeze a month's statement into billing_periods (T-B1-04). Idempotent per
  // project+period: re-freezing updates the row. Aborts with 409 when the two
  // independent aggregation paths disagree, so a drift can never be snapshotted.
  routes.post('/billing/freeze', (c) => {
    const raw = c.req.query('period')?.trim();
    const period = raw && raw.length > 0 ? raw : new Date().toISOString().slice(0, 7);

    try {
      return c.json(freezeStatement(usageRepo, billingPeriodRepo, period));
    } catch (error) {
      if (error instanceof ValidationError) return validationResponse(c, error);
      if (error instanceof ReconciliationError) {
        return c.json(
          { error: { code: 'reconciliation_error', message: error.message } },
          409,
        );
      }
      throw error;
    }
  });

  return routes;
}
