import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

/**
 * OB-01: model-hub `/metrics` for the Tier0 collector. Aggregate usage counts
 * by model + billing_source, plus the always-up gauge and registered
 * projects/providers. No prompt content, key material or project id ever
 * becomes a label.
 */

interface UsageOverrides {
  id?: string;
  model?: string;
  billing_source?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_micros?: number | null;
}

function insertUsage(db: DatabaseSync, overrides: UsageOverrides = {}): void {
  const row = {
    id: 'use-1',
    project_id: 'prj-1',
    feature: 'chat',
    billing_source: 'builtin',
    provider: 'ark',
    model: 'doubao-seed-1-6',
    input_tokens: 100,
    output_tokens: 50,
    http_status: 200,
    cost_micros: 1234,
    ts: '2026-11-27T00:00:00.000Z',
    created_at: '2026-11-27T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO usage_events
       (id, project_id, feature, billing_source, provider, model,
        input_tokens, output_tokens, http_status, cost_micros, ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project_id,
    row.feature,
    row.billing_source,
    row.provider,
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.http_status,
    row.cost_micros,
    row.ts,
    row.created_at,
  );
}

describe('model-hub /metrics', () => {
  it('serves the up gauge and zero counts on an empty hub', async () => {
    const t = makeTestApp();
    const res = await t.app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('modelhub_up 1');
    expect(body).toContain('modelhub_projects 0');
    expect(body).toContain('modelhub_providers 0');
    expect(body).not.toContain('modelhub_usage_calls');
  });

  it('exposes usage counts grouped by model and billing source', async () => {
    const t = makeTestApp();
    insertUsage(t.db, { model: 'doubao-seed-1-6', billing_source: 'builtin' });
    insertUsage(t.db, {
      id: 'use-2',
      model: 'doubao-seed-1-6',
      billing_source: 'byok',
      input_tokens: 10,
      output_tokens: 5,
      cost_micros: null,
    });
    insertUsage(t.db, {
      id: 'use-3',
      model: 'agnes-video-2.5-flash',
      input_tokens: 0,
      output_tokens: 0,
      cost_micros: 500,
    });

    const res = await t.app.request('/metrics');
    const body = await res.text();

    expect(body).toContain(
      'modelhub_usage_calls{model="doubao-seed-1-6",billing_source="builtin"} 1',
    );
    expect(body).toContain(
      'modelhub_usage_calls{model="doubao-seed-1-6",billing_source="byok"} 1',
    );
    expect(body).toContain(
      'modelhub_usage_input_tokens{model="doubao-seed-1-6",billing_source="builtin"} 100',
    );
    expect(body).toContain(
      'modelhub_usage_cost_micros{model="doubao-seed-1-6",billing_source="builtin"} 1234',
    );
    // BYOK rows carry a NULL cost, which the metrics render as zero.
    expect(body).toContain(
      'modelhub_usage_cost_micros{model="doubao-seed-1-6",billing_source="byok"} 0',
    );
    expect(body).toContain(
      'modelhub_usage_calls{model="agnes-video-2.5-flash",billing_source="builtin"} 1',
    );
  });
});
