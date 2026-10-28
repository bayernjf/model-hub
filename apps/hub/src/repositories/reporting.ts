import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../ids.js';

export interface UsageEventInsert {
  project_id: string;
  feature: string;
  billing_source: string;
  billing_type: string | null;
  provider: string;
  model: string;
  assignment_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number | null;
  quantity: number | null;
  http_status: number;
  cached: boolean;
  cost_micros: number | null;
  ts: string;
}

export interface HealthCheckInsert {
  project_id: string;
  assignment_id: string | null;
  alias: string | null;
  level: string;
  ok: boolean;
  latency_ms: number;
  error_code: string | null;
  error_detail: string | null;
  error_hint: string | null;
  ts: string;
}

export interface UsageEventView {
  id: string;
  project_id: string;
  feature: string;
  billing_source: string;
  provider: string;
  model: string;
  assignment_id: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number | null;
  quantity: number | null;
  http_status: number;
  cost_micros: number | null;
  ts: string;
}

export interface HealthCheckView {
  id: string;
  project_id: string;
  assignment_id: string | null;
  alias: string | null;
  level: string;
  ok: boolean;
  latency_ms: number;
  error_code: string | null;
  ts: string;
}

// One row of the W7-4 cost dashboard aggregation (project × source × day × model).
export interface CostAggregateRow {
  project: string;
  billing_source: string;
  day: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  quantity: number;
  cost_micros: number;
}

export class UsageRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(input: UsageEventInsert): UsageEventView {
    const id = newId('use');
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO usage_events
           (id, project_id, feature, billing_source, billing_type, provider,
            model, assignment_id, input_tokens, output_tokens,
            cache_read_tokens, reasoning_tokens, quantity, http_status,
            cached, cost_micros, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project_id,
        input.feature,
        input.billing_source,
        input.billing_type,
        input.provider,
        input.model,
        input.assignment_id,
        input.input_tokens,
        input.output_tokens,
        input.cache_read_tokens,
        input.reasoning_tokens,
        input.quantity,
        input.http_status,
        input.cached ? 1 : 0,
        input.cost_micros,
        input.ts,
        createdAt,
      );
    return {
      id,
      project_id: input.project_id,
      feature: input.feature,
      billing_source: input.billing_source,
      provider: input.provider,
      model: input.model,
      assignment_id: input.assignment_id,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      reasoning_tokens: input.reasoning_tokens,
      quantity: input.quantity,
      http_status: input.http_status,
      cost_micros: input.cost_micros,
      ts: input.ts,
    };
  }

  listByProject(projectId: string, limit: number = 200): UsageEventView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM usage_events WHERE project_id = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as Array<{
      id: string;
      project_id: string;
      feature: string;
      billing_source: string;
      provider: string;
      model: string;
      assignment_id: string | null;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number | null;
      quantity: number | null;
      http_status: number;
      cost_micros: number | null;
      ts: string;
    }>;
    return rows;
  }

  // Raw aggregation for the read-only cost dashboard (W7-4). Groups by project
  // slug × billing_source × day × model. byok rows carry no cost (owner does
  // not pay for user keys); their volume is still summed for display.
  aggregate(): CostAggregateRow[] {
    return this.db
      .prepare(
        `SELECT p.slug AS project,
                u.billing_source AS billing_source,
                date(u.ts) AS day,
                u.model AS model,
                COUNT(*) AS calls,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(u.quantity), 0) AS quantity,
                COALESCE(SUM(u.cost_micros), 0) AS cost_micros
         FROM usage_events u
         JOIN projects p ON p.id = u.project_id
         GROUP BY p.slug, u.billing_source, date(u.ts), u.model
         ORDER BY day DESC, project ASC, model ASC`,
      )
      .all() as unknown as CostAggregateRow[];
  }
}

export class HealthCheckRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(input: HealthCheckInsert): HealthCheckView {
    const id = newId('hc');
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO health_checks
           (id, project_id, assignment_id, alias, level, ok, latency_ms,
            error_code, error_detail, error_hint, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.project_id,
        input.assignment_id,
        input.alias,
        input.level,
        input.ok ? 1 : 0,
        input.latency_ms,
        input.error_code,
        input.error_detail,
        input.error_hint,
        input.ts,
        createdAt,
      );
    return {
      id,
      project_id: input.project_id,
      assignment_id: input.assignment_id,
      alias: input.alias,
      level: input.level,
      ok: input.ok,
      latency_ms: input.latency_ms,
      error_code: input.error_code,
      ts: input.ts,
    };
  }

  // Latest health row per (project, assignment), optionally scoped.
  private latest(projectId?: string): HealthCheckView[] {
    const rows = this.db
      .prepare(
        `SELECT h.* FROM health_checks h
         WHERE h.id = (
           SELECT h2.id FROM health_checks h2
           WHERE h2.project_id = h.project_id
             AND (h2.assignment_id IS h.assignment_id
                  OR (h2.assignment_id IS NULL AND h.assignment_id IS NULL))
           ORDER BY h2.ts DESC LIMIT 1
         )
         ${projectId ? 'AND h.project_id = ?' : ''}
         ORDER BY h.project_id, h.ts DESC`,
      )
      .all(...(projectId ? [projectId] : [])) as unknown as Array<{
      id: string;
      project_id: string;
      assignment_id: string | null;
      alias: string | null;
      level: string;
      ok: number;
      latency_ms: number;
      error_code: string | null;
      ts: string;
    }>;
    return rows.map((r) => ({ ...r, ok: r.ok === 1 }));
  }

  latestByProject(projectId: string): HealthCheckView[] {
    return this.latest(projectId);
  }

  latestAll(): HealthCheckView[] {
    return this.latest();
  }
}
