import { buildStatement, periodBounds } from './billing.js';
import type { BillingPeriodRepository } from './repositories/billing-periods.js';
import type { UsageRepository } from './repositories/reporting.js';

// Freeze a UTC month's billing statement (T-B1-04). The freeze snapshots the
// per-project billable amount into billing_periods, after asserting that two
// independent implementations agree to the micro: the aggregate + buildStatement
// pipeline, and the per-project SQL in BillingPeriodRepository. A disagreement
// means money is silently moving, so the freeze aborts instead of writing.

export class ReconciliationError extends Error {
  constructor(
    public readonly expectedMicros: number,
    public readonly actualMicros: number,
  ) {
    super(
      `billing freeze reconciliation failed: ` +
        `frozen total ${actualMicros} != statement billable ${expectedMicros}`,
    );
    this.name = 'ReconciliationError';
  }
}

export interface FrozenProjectLine {
  projectId: string;
  amountMicros: number;
}

export interface FreezeResult {
  period: string;
  frozen: FrozenProjectLine[];
  totalBillableMicros: number;
}

export function freezeStatement(
  usageRepo: UsageRepository,
  billingPeriodRepo: BillingPeriodRepository,
  period: string,
): FreezeResult {
  const bounds = periodBounds(period);
  const window = { from: bounds.from, to: bounds.to };

  const rows = usageRepo.aggregate(window);
  const statement = buildStatement(
    rows,
    bounds.period,
    usageRepo.unattributedRows(window),
  );
  const byProject = billingPeriodRepo.billableByProject(window);

  // Reconciliation: the two sums must match exactly or the freeze aborts.
  const frozenTotal = byProject.reduce((sum, row) => sum + row.amount_micros, 0);
  if (frozenTotal !== statement.billable.amount_micros) {
    throw new ReconciliationError(statement.billable.amount_micros, frozenTotal);
  }

  const frozen = byProject.map((row) => {
    const view = billingPeriodRepo.freezePeriod(
      row.project_id,
      bounds.period,
      row.amount_micros,
    );
    return { projectId: view.project_id, amountMicros: view.amount_micros };
  });

  return {
    period: bounds.period,
    frozen,
    totalBillableMicros: statement.billable.amount_micros,
  };
}
