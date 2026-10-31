import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';

// W7-4 read-only cost dashboard: aggregation math must split builtin owner
// cost from byok volume, and break down by project / model / day.

async function setup(opts?: { dailyBudgetMicros?: number }) {
  const t = makeTestApp();
  const cookie = await login(t.app);

  const provRes = await t.app.request('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name: 'Ark',
      preset_id: 'ark',
      protocol: 'openai-compatible',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'vendor-secret-key',
    }),
  });
  const provider = (await provRes.json()) as { provider: { id: string } };

  const importRes = await t.app.request(
    `/api/admin/providers/${provider.provider.id}/models/import`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        preset_provider_id: 'ark',
        model_ids: ['doubao-seed-1-6'],
      }),
    },
  );
  const imported = (await importRes.json()) as {
    imported: Array<{ id: string }>;
  };
  const modelId = imported.imported[0]?.id ?? '';

  await t.app.request(`/api/admin/models/${modelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ enabled: true }),
  });

  const prjRes = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug: 'zeus', display_name: 'Zeus' }),
  });
  const projectId = ((await prjRes.json()) as { project: { id: string } })
    .project.id;

  const tokRes = await t.app.request(
    `/api/admin/projects/${projectId}/rotate-token`,
    { method: 'POST', headers: { Cookie: cookie } },
  );
  const token = ((await tokRes.json()) as { token: string }).token;

  const asnRes = await t.app.request('/api/admin/assignments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      project_id: projectId,
      assignments: [
        {
          model_id: modelId,
          alias: 'noul',
          ...(opts?.dailyBudgetMicros !== undefined
            ? { daily_budget_micros: opts.dailyBudgetMicros }
            : {}),
        },
      ],
    }),
  });
  const assignmentId = (
    (await asnRes.json()) as { assignments: Array<{ id: string }> }
  ).assignments[0]?.id;

  return { t, cookie, token, assignmentId: assignmentId ?? '' };
}

const baseUsage = {
  project: 'zeus',
  feature: 'noul',
  billing_type: 'payg',
  provider: 'ark',
  model: 'doubao-seed-1-6-250615',
  cache_read_tokens: 0,
  http_status: 200,
  cached: false,
};

describe('cost dashboard', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  async function report(body: Record<string, unknown>) {
    return s.t.app.request('/pub/v1/usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('aggregates builtin cost and byok volume by project/model/day', async () => {
    // Two builtin calls on the same day.
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 1000,
      output_tokens: 500,
      reasoning_tokens: 120,
      cache_read_tokens: 300,
      ts: '2026-10-28T10:00:00.000Z',
    });
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 2000,
      output_tokens: 1000,
      reasoning_tokens: 80,
      cache_read_tokens: 0,
      ts: '2026-10-28T12:00:00.000Z',
    });
    // One byok call, previous day.
    await report({
      ...baseUsage,
      billing_source: 'byok',
      assignment_id: null,
      input_tokens: 500,
      output_tokens: 250,
      reasoning_tokens: 40,
      cache_read_tokens: 60,
      ts: '2026-10-27T09:00:00.000Z',
    });

    const res = await s.t.app.request('/api/admin/costs', {
      headers: { Cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totals: {
        builtin: {
          calls: number;
          input_tokens: number;
          output_tokens: number;
          reasoning_tokens: number;
          cache_read_tokens: number;
          cost_micros: number;
        };
        byok: {
          calls: number;
          input_tokens: number;
          output_tokens: number;
          reasoning_tokens: number;
          cache_read_tokens: number;
          cost_micros: number;
        };
      };
      by_project: Array<{
        project: string;
        builtin: { calls: number; cost_micros: number };
        byok: { calls: number };
      }>;
      by_model: Array<{
        project: string;
        model: string;
        builtin: { calls: number; cost_micros: number };
      }>;
      by_day: Array<{
        day: string;
        builtin: { calls: number; cost_micros: number };
        byok: { calls: number };
      }>;
    };

    expect(data.totals.builtin.calls).toBe(2);
    expect(data.totals.builtin.input_tokens).toBe(3000);
    expect(data.totals.builtin.output_tokens).toBe(1500);
    expect(data.totals.builtin.reasoning_tokens).toBe(200);
    expect(data.totals.builtin.cache_read_tokens).toBe(300);
    expect(data.totals.builtin.cost_micros).toBeGreaterThan(0);
    expect(data.totals.byok.calls).toBe(1);
    // byok volume is surfaced, byok cost stays zero.
    expect(data.totals.byok.input_tokens).toBe(500);
    expect(data.totals.byok.reasoning_tokens).toBe(40);
    expect(data.totals.byok.cache_read_tokens).toBe(60);
    expect(data.totals.byok.cost_micros).toBe(0);

    const proj = data.by_project.find((r) => r.project === 'zeus');
    expect(proj?.builtin.calls).toBe(2);
    expect(proj?.byok.calls).toBe(1);

    const modelRow = data.by_model.find(
      (r) => r.model === 'doubao-seed-1-6-250615',
    );
    expect(modelRow?.project).toBe('zeus');
    expect(modelRow?.builtin.calls).toBe(2);

    const dayRows = Object.fromEntries(
      data.by_day.map((r) => [r.day, r] as const),
    );
    expect(dayRows['2026-10-28']?.builtin.calls).toBe(2);
    expect(dayRows['2026-10-27']?.byok.calls).toBe(1);
    expect(dayRows['2026-10-27']?.builtin.calls).toBe(0);
  });

  it('filters by an inclusive from/to window', async () => {
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 1000,
      output_tokens: 500,
      reasoning_tokens: 100,
      cache_read_tokens: 200,
      ts: '2026-10-26T08:00:00.000Z',
    });
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 2000,
      output_tokens: 1000,
      reasoning_tokens: 300,
      cache_read_tokens: 400,
      ts: '2026-10-27T12:00:00.000Z',
    });
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 4000,
      output_tokens: 2000,
      reasoning_tokens: 600,
      cache_read_tokens: 800,
      ts: '2026-10-28T18:00:00.000Z',
    });

    const fetchCosts = (query: string) =>
      s.t.app.request(`/api/admin/costs${query}`, {
        headers: { Cookie: s.cookie },
      });

    // Date-only bounds cover whole UTC days (inclusive on both ends).
    const dayWindow = (await (
      await fetchCosts('?from=2026-10-27&to=2026-10-27')
    ).json()) as { totals: { builtin: { calls: number; input_tokens: number } } };
    expect(dayWindow.totals.builtin.calls).toBe(1);
    expect(dayWindow.totals.builtin.input_tokens).toBe(2000);

    // Open-ended windows: only a lower or only an upper bound.
    const fromOnly = (await (await fetchCosts('?from=2026-10-27'))
      .json()) as { totals: { builtin: { calls: number } } };
    expect(fromOnly.totals.builtin.calls).toBe(2);

    const toOnly = (await (await fetchCosts('?to=2026-10-26')).json()) as {
      totals: { builtin: { calls: number } };
    };
    expect(toOnly.totals.builtin.calls).toBe(1);

    // Full UTC timestamps are honored as-is (the day's event sits at 18:00).
    const tsWindow = (await (
      await fetchCosts('?from=2026-10-28T00:00:00Z&to=2026-10-28T20:00:00Z')
    ).json()) as { totals: { builtin: { calls: number } } };
    expect(tsWindow.totals.builtin.calls).toBe(1);

    // A window matching nothing yields empty totals, not an error.
    const empty = (await (await fetchCosts('?from=2020-01-01&to=2020-01-02'))
      .json()) as { totals: { builtin: { calls: number } } };
    expect(empty.totals.builtin.calls).toBe(0);
  });

  it('rejects malformed window bounds', async () => {
    const badFrom = await s.t.app.request('/api/admin/costs?from=yesterday', {
      headers: { Cookie: s.cookie },
    });
    expect(badFrom.status).toBe(400);
    const badFromBody = (await badFrom.json()) as {
      error: { code: string; field: string };
    };
    expect(badFromBody.error.code).toBe('validation_error');
    expect(badFromBody.error.field).toBe('from');

    const badTo = await s.t.app.request('/api/admin/costs?to=not-a-date', {
      headers: { Cookie: s.cookie },
    });
    expect(badTo.status).toBe(400);

    const inverted = await s.t.app.request(
      '/api/admin/costs?from=2026-10-28&to=2026-10-27',
      { headers: { Cookie: s.cookie } },
    );
    expect(inverted.status).toBe(400);
  });

  it('answers empty totals when no usage exists', async () => {
    const res = await s.t.app.request('/api/admin/costs', {
      headers: { Cookie: s.cookie },
    });
    const data = (await res.json()) as {
      totals: { builtin: { calls: number }; byok: { calls: number } };
    };
    expect(data.totals.builtin.calls).toBe(0);
    expect(data.totals.byok.calls).toBe(0);
  });
});

describe('budget watermark column (W5-3)', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup({ dailyBudgetMicros: 1_000_000 });
  });

  async function report(body: Record<string, unknown>) {
    return s.t.app.request('/pub/v1/usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function fetchBudgets(query = '') {
    const res = await s.t.app.request(`/api/admin/costs${query}`, {
      headers: { Cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      budgets: Array<{
        project: string;
        assignment_id: string;
        alias: string | null;
        role: string;
        model: string;
        spent_micros: number;
        daily_budget_micros: number;
        percent: number | null;
      }>;
    };
  }

  it('shows today UTC spend against the daily budget', async () => {
    // 1M input + 1M output at doubao-seed-1-6 pricing = 420000 micros.
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      ts: new Date().toISOString(),
    });

    const data = await fetchBudgets();
    expect(data.budgets).toHaveLength(1);
    const row = data.budgets[0]!;
    expect(row.project).toBe('zeus');
    expect(row.assignment_id).toBe(s.assignmentId);
    expect(row.alias).toBe('noul');
    expect(row.role).toBe('primary');
    expect(row.model).toBe('doubao-seed-1-6-250615');
    expect(row.spent_micros).toBe(420_000);
    expect(row.daily_budget_micros).toBe(1_000_000);
    expect(row.percent).toBe(42);
  });

  it('is unaffected by the requested aggregation window', async () => {
    await report({
      ...baseUsage,
      billing_source: 'builtin',
      assignment_id: s.assignmentId,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      ts: '2026-10-27T10:00:00.000Z',
    });

    // The window excludes the report, but the watermark is a "now" reading
    // for the current UTC day, so it stays at zero.
    const data = await fetchBudgets('?from=2026-10-27&to=2026-10-28');
    expect(data.budgets[0]?.spent_micros).toBe(0);
    expect(data.budgets[0]?.percent).toBe(0);
  });

  it('omits assignments without a configured budget', async () => {
    const plain = await setup();
    const res = await plain.t.app.request('/api/admin/costs', {
      headers: { Cookie: plain.cookie },
    });
    const data = (await res.json()) as {
      budgets: unknown[];
    };
    expect(data.budgets).toEqual([]);
  });
});
