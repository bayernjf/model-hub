import type { DatabaseSync } from 'node:sqlite';

/**
 * Read-only Prometheus metrics for the Tier0 collector.
 *
 * The snapshot is derived from persisted rows only. No prompt content, key
 * material or project identifiers become labels: `model` and `billing_source`
 * are the only bounded label dimensions, so the local Prometheus never turns
 * into a copy of the usage table.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface ModelHubUsageSample {
  model: string;
  billingSource: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface ModelHubMetricsSnapshot {
  capturedAt: string;
  uptimeSeconds: number;
  usage: ModelHubUsageSample[];
  projects: number;
  providers: number;
}

interface UsageRow {
  model: string;
  billing_source: string;
  calls: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cost_micros: unknown;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class ModelHubMetricsService {
  private readonly startedAtMs: number;

  constructor(
    private readonly db: DatabaseSync,
    startedAtMs = Date.now(),
  ) {
    this.startedAtMs = startedAtMs;
  }

  getMetrics(now = new Date()): ModelHubMetricsSnapshot {
    const usageRows = this.db
      .prepare(
        `SELECT model,
                billing_source,
                COUNT(*)                       AS calls,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_micros), 0)  AS cost_micros
         FROM usage_events
         GROUP BY model, billing_source
         ORDER BY model, billing_source`,
      )
      .all() as UsageRow[];

    const projects = this.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as
      | { n: unknown }
      | undefined;
    const providers = this.db.prepare('SELECT COUNT(*) AS n FROM providers').get() as
      | { n: unknown }
      | undefined;

    return {
      capturedAt: now.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - this.startedAtMs) / 1000)),
      usage: usageRows.map(row => ({
        model: row.model,
        billingSource: row.billing_source,
        calls: count(row.calls),
        inputTokens: count(row.input_tokens),
        outputTokens: count(row.output_tokens),
        costMicros: count(row.cost_micros),
      })),
      projects: count(projects?.n),
      providers: count(providers?.n),
    };
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

class Family {
  private readonly samples: string[] = [];

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly type: 'gauge' | 'counter',
  ) {}

  add(value: number, pairs: ReadonlyArray<readonly [string, string]> = []): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(`${this.name}${labels(pairs)} ${value}`);
  }

  render(): string {
    if (this.samples.length === 0) return '';
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n${this.samples.join('\n')}\n`;
  }
}

export function renderPrometheusMetrics(snapshot: ModelHubMetricsSnapshot): string {
  const blocks: string[] = [];
  const push = (family: Family): void => {
    const text = family.render();
    if (text) blocks.push(text);
  };

  const up = new Family('modelhub_up', 'Always 1 while the hub serves a metrics snapshot.', 'gauge');
  up.add(1);
  push(up);

  const uptime = new Family('modelhub_uptime_seconds', 'Process uptime in seconds.', 'gauge');
  uptime.add(snapshot.uptimeSeconds);
  push(uptime);

  const captured = new Family(
    'modelhub_metrics_snapshot_timestamp_seconds',
    'Unix time the snapshot was captured; a stale value means the aggregation stopped advancing.',
    'gauge',
  );
  captured.add(Date.parse(snapshot.capturedAt) / 1000);
  push(captured);

  const calls = new Family('modelhub_usage_calls', 'Recorded usage calls, by model and billing source.', 'gauge');
  const inputTokens = new Family('modelhub_usage_input_tokens', 'Recorded input tokens, by model and billing source.', 'gauge');
  const outputTokens = new Family('modelhub_usage_output_tokens', 'Recorded output tokens, by model and billing source.', 'gauge');
  const costMicros = new Family('modelhub_usage_cost_micros', 'Recorded cost in micros, by model and billing source.', 'gauge');
  for (const sample of snapshot.usage) {
    const pair: ReadonlyArray<readonly [string, string]> = [
      ['model', sample.model],
      ['billing_source', sample.billingSource],
    ];
    calls.add(sample.calls, pair);
    inputTokens.add(sample.inputTokens, pair);
    outputTokens.add(sample.outputTokens, pair);
    costMicros.add(sample.costMicros, pair);
  }
  push(calls);
  push(inputTokens);
  push(outputTokens);
  push(costMicros);

  const projects = new Family('modelhub_projects', 'Registered projects, all states.', 'gauge');
  projects.add(snapshot.projects);
  push(projects);

  const providers = new Family('modelhub_providers', 'Registered providers, all states.', 'gauge');
  providers.add(snapshot.providers);
  push(providers);

  return blocks.join('\n');
}
