import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../ids.js';
import type { CostAggregateWindow } from './reporting.js';

// Persistence for frozen billing statements (T-B1-04). The statement stays a
// reproducible view over usage_events (T-B1-02); this repository snapshots it
// into billing_periods so a bill can be issued from a stable row.

/** One project's billable amount inside a window (byok excluded). */
export interface BillableProjectRow {
  project_id: string;
  amount_micros: number;
}

export interface BillingPeriodView {
  id: string;
  project_id: string;
  period: string;
  amount_micros: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export class BillingPeriodRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Builtin (billable) spend grouped by project within the window. This is the
   * independent SQL implementation the freeze reconciliation checks against the
   * aggregate + buildStatement pipeline: the two must agree to the micro.
   */
  billableByProject(window: CostAggregateWindow): BillableProjectRow[] {
    const conditions: string[] = ["u.billing_source <> 'byok'"];
    const params: string[] = [];
    if (window.from) {
      conditions.push('u.ts >= ?');
      params.push(window.from);
    }
    if (window.to) {
      conditions.push('u.ts <= ?');
      params.push(window.to);
    }
    return this.db
      .prepare(
        `SELECT u.project_id AS project_id,
                COALESCE(SUM(u.cost_micros), 0) AS amount_micros
         FROM usage_events u
         WHERE ${conditions.join(' AND ')}
         GROUP BY u.project_id`,
      )
      .all(...params) as unknown as BillableProjectRow[];
  }

  /**
   * Freeze (upsert) one project's billable amount for a month. Re-freezing the
   * same period updates the row in place: no duplicate is ever created.
   */
  freezePeriod(projectId: string, period: string, amountMicros: number): BillingPeriodView {
    const now = nowIso();
    const existing = this.db
      .prepare('SELECT * FROM billing_periods WHERE project_id = ? AND period = ?')
      .get(projectId, period) as BillingPeriodView | undefined;

    if (existing !== undefined) {
      this.db
        .prepare(
          `UPDATE billing_periods
           SET amount_micros = ?, status = 'frozen', updated_at = ?
           WHERE id = ?`,
        )
        .run(amountMicros, now, existing.id);
      return { ...existing, amount_micros: amountMicros, updated_at: now };
    }

    const id = newId('blp');
    this.db
      .prepare(
        `INSERT INTO billing_periods
           (id, project_id, period, amount_micros, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'frozen', ?, ?)`,
      )
      .run(id, projectId, period, amountMicros, now, now);
    return {
      id,
      project_id: projectId,
      period,
      amount_micros: amountMicros,
      status: 'frozen',
      created_at: now,
      updated_at: now,
    };
  }

  /** All frozen rows for one month, newest first. */
  listByPeriod(period: string): BillingPeriodView[] {
    return this.db
      .prepare(
        `SELECT * FROM billing_periods WHERE period = ?
         ORDER BY project_id ASC`,
      )
      .all(period) as unknown as BillingPeriodView[];
  }
}
