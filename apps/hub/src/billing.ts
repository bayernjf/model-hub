import type { CostAggregateRow } from './repositories/reporting.js';
import { ValidationError } from './validation.js';

// Billing statement for one UTC calendar month (M-billing, T-B1-02).
//
// The meter already exists: `usage_events` records cost_micros per call and
// the cost dashboard splits builtin from byok. What was missing is a
// month-shaped view a customer can read as a bill.
//
// Two rules are copied from the existing dashboard on purpose, because a
// bill that disagrees with the dashboard is worse than no bill:
//   1. byok usage is METERED, never BILLED -- it is the customer's own key,
//      so its money never passes through us.
//   2. cost_micros is summed as stored; it is not recomputed here. Recomputing
//      at report time would drift from what the ledger recorded.
//
// Periods are UTC calendar months: the stored ts is ISO-8601 with a Z suffix,
// so a request belongs to the month its UTC timestamp falls in.

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface BillingPeriod {
  period: string;
  /** Inclusive, first millisecond of the month (UTC). */
  from: string;
  /** Inclusive, last millisecond of the month (UTC). */
  to: string;
}

/** Accepts `YYYY-MM` and resolves it to a closed UTC interval. */
export function periodBounds(period: string, field = 'period'): BillingPeriod {
  const match = PERIOD_RE.exec(period.trim());
  if (!match) {
    throw new ValidationError(field, `${field} must be a UTC month formatted as YYYY-MM`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Date.UTC month is 0-based, so passing `month` (1-12) lands on the next
  // month's first day; one millisecond back is this month's last instant.
  const nextMonthStart = Date.UTC(year, month, 1);
  const to = new Date(nextMonthStart - 1).toISOString();
  return { period: `${match[1]}-${match[2]}`, from: `${match[1]}-${match[2]}-01T00:00:00.000Z`, to };
}

export interface BillingBucket {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  quantity: number;
  /** Summed cost_micros. Always 0 for the metered-only (byok) bucket. */
  amount_micros: number;
}

export interface BillingProjectLine {
  project: string;
  billable_micros: number;
  /** byok tokens in this period; volume only, no money. */
  metered_tokens: number;
  calls: number;
}

export interface BillingModelLine {
  project: string;
  model: string;
  billable_micros: number;
  calls: number;
  /** byok calls on this model; they cost nothing to bill but did happen. */
  metered_calls: number;
}

export interface BillingStatement {
  period: string;
  period_start: string;
  period_end: string;
  currency: 'USD';
  /** builtin usage: the part of the statement that carries a price. */
  billable: BillingBucket;
  /** byok usage: same units, amount_micros pinned to 0 by definition. */
  metered_only: BillingBucket;
  by_project: BillingProjectLine[];
  by_model: BillingModelLine[];
  /** Rows the repository returned that belong to another month. */
  excluded_rows: number;
  /** Window rows whose project is not registered, so no project line can own
   * them. They never enter billable or metered_only, hence never the total. */
  unattributed_rows: number;
  note: string;
}

function emptyBucket(): BillingBucket {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    quantity: 0,
    amount_micros: 0,
  };
}

function addRow(bucket: BillingBucket, row: CostAggregateRow, withCost: boolean): void {
  bucket.calls += row.calls;
  bucket.input_tokens += row.input_tokens;
  bucket.output_tokens += row.output_tokens;
  bucket.cache_read_tokens += row.cache_read_tokens;
  bucket.quantity += row.quantity;
  if (withCost) {
    // cost_micros is nullable in the table (unknown price); a missing price
    // must not turn into NaN and poison the whole statement.
    bucket.amount_micros += Number(row.cost_micros) || 0;
  }
}

/**
 * Build the statement. Rows outside `period` are dropped and counted: the
 * repository window and this function must agree, and a silent disagreement
 * would move money between months without anyone noticing.
 */
export function buildStatement(
  rows: readonly CostAggregateRow[],
  period: string,
  unattributedRows = 0,
): BillingStatement {
  const bounds = periodBounds(period);
  const month = bounds.period;

  const billable = emptyBucket();
  const meteredOnly = emptyBucket();
  const byProject = new Map<string, BillingProjectLine>();
  const byModel = new Map<string, BillingModelLine>();
  let excluded = 0;

  for (const row of rows) {
    if ((row.day ?? '').slice(0, 7) !== month) {
      excluded += 1;
      continue;
    }

    const isByok = row.billing_source === 'byok';
    addRow(isByok ? meteredOnly : billable, row, !isByok);

    const projectLine =
      byProject.get(row.project) ??
      ((): BillingProjectLine => {
        const line: BillingProjectLine = {
          project: row.project,
          billable_micros: 0,
          metered_tokens: 0,
          calls: 0,
        };
        byProject.set(row.project, line);
        return line;
      })();
    projectLine.calls += row.calls;
    if (isByok) {
      projectLine.metered_tokens += row.input_tokens + row.output_tokens + row.cache_read_tokens;
    } else {
      projectLine.billable_micros += Number(row.cost_micros) || 0;
    }

    const modelKey = `${row.project}\u0000${row.model}`;
    const modelLine =
      byModel.get(modelKey) ??
      ((): BillingModelLine => {
        const line: BillingModelLine = {
          project: row.project,
          model: row.model,
          billable_micros: 0,
          calls: 0,
          metered_calls: 0,
        };
        byModel.set(modelKey, line);
        return line;
      })();
    modelLine.calls += row.calls;
    if (isByok) modelLine.metered_calls += row.calls;
    else modelLine.billable_micros += Number(row.cost_micros) || 0;
  }

  return {
    period: month,
    period_start: bounds.from,
    period_end: bounds.to,
    currency: 'USD',
    billable,
    metered_only: meteredOnly,
    by_project: [...byProject.values()].sort((a, b) => b.billable_micros - a.billable_micros),
    by_model: [...byModel.values()].sort((a, b) => b.billable_micros - a.billable_micros),
    excluded_rows: excluded,
    unattributed_rows: Math.max(0, Math.trunc(unattributedRows)),
    note: 'byok usage is metered, not billed: its cost_micros never enters amount_micros',
  };
}
