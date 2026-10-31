import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';
import {
  UsageRepository,
  type UsageEventInsert,
} from '../src/repositories/reporting.js';

// W5-1 budget readout: GET /pub/v1/usage/summary aggregates the current UTC
// day's builtin spend per assignment against its daily budget.

async function setup() {
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
        model_ids: ['doubao-seed-1-6', 'doubao-seed-evolving'],
      }),
    },
  );
  const imported = (await importRes.json()) as {
    imported: Array<{ id: string }>;
  };
  const seedId = imported.imported[0]?.id ?? '';
  const evolvingId = imported.imported[1]?.id ?? '';

  for (const id of [seedId, evolvingId]) {
    await t.app.request(`/api/admin/models/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    });
  }

  const prjRes = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug: 'zeus', display_name: 'Zeus' }),
  });
  const project = (await prjRes.json()) as { project: { id: string } };

  const tokRes = await t.app.request(
    `/api/admin/projects/${project.project.id}/rotate-token`,
    { method: 'POST', headers: { Cookie: cookie } },
  );
  const token = (await tokRes.json()) as { token: string };

  // 'noul' carries a daily budget; 'deep' has none (percent must stay null).
  const asnRes = await t.app.request('/api/admin/assignments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      project_id: project.project.id,
      assignments: [
        {
          model_id: seedId,
          alias: 'noul',
          role: 'primary',
          daily_budget_micros: 1_000_000,
        },
        { model_id: evolvingId, alias: 'deep', role: 'fallback' },
      ],
    }),
  });
  const assignments = (await asnRes.json()) as {
    assignments: Array<{ id: string; alias: string | null }>;
  };
  const byAlias = new Map(
    assignments.assignments.map((a) => [a.alias, a.id] as const),
  );

  return {
    t,
    cookie,
    projectId: project.project.id,
    token: token.token,
    noulId: byAlias.get('noul') ?? '',
    deepId: byAlias.get('deep') ?? '',
  };
}

describe('usage summary endpoint', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  function summary(auth?: string) {
    return s.t.app.request('/pub/v1/usage/summary', {
      headers: auth === undefined ? {} : { Authorization: `Bearer ${auth}` },
    });
  }

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

  it('rejects a missing or unknown token', async () => {
    expect((await summary()).status).toBe(401);
    expect((await summary('mh_not_a_token')).status).toBe(401);
  });

  it('returns an empty readout for a project without usage', async () => {
    const res = await summary(s.token);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      project: string;
      day: string;
      models: Array<Record<string, unknown>>;
      unassigned_spent_micros: number;
    };
    expect(data.project).toBe('zeus');
    expect(data.day).toBe(new Date().toISOString().slice(0, 10));
    expect(data.models).toHaveLength(2);
    expect(data.unassigned_spent_micros).toBe(0);
  });

  it('aggregates today spend per alias with spent/limit/percent', async () => {
    // doubao-seed-1-6 pricing: 0.12 USD/M input, 0.3 USD/M output.
    // 1M input + 1M output = 120000 + 300000 = 420000 micros (42% of 1M).
    await report({
      project: 'zeus',
      feature: 'noul',
      billing_source: 'builtin',
      provider: 'ark',
      model: 'doubao-seed-1-6-250615',
      assignment_id: s.noulId,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      http_status: 200,
      cached: false,
      ts: new Date().toISOString(),
    });

    const data = (await (await summary(s.token)).json()) as {
      models: Array<{
        assignment_id: string;
        alias: string | null;
        role: string;
        model: string;
        spent_micros: number;
        daily_budget_micros: number | null;
        percent: number | null;
      }>;
    };
    const noul = data.models.find((m) => m.alias === 'noul');
    const deep = data.models.find((m) => m.alias === 'deep');
    expect(noul?.spent_micros).toBe(420_000);
    expect(noul?.daily_budget_micros).toBe(1_000_000);
    expect(noul?.percent).toBe(42);
    expect(deep?.spent_micros).toBe(0);
    expect(deep?.daily_budget_micros).toBeNull();
    expect(deep?.percent).toBeNull();
  });

  it('draws the day boundary at UTC midnight', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const repo = new UsageRepository(s.t.db);
    const base: Omit<UsageEventInsert, 'ts'> = {
      project_id: s.projectId,
      feature: 'noul',
      billing_source: 'builtin',
      billing_type: 'payg',
      provider: 'ark',
      model: 'doubao-seed-1-6-250615',
      assignment_id: s.noulId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: null,
      quantity: null,
      http_status: 200,
      cached: false,
      cost_micros: null,
    };
    repo.append({ ...base, cost_micros: 999, ts: `${yesterday}T23:59:59.999Z` });
    repo.append({ ...base, cost_micros: 100, ts: `${day}T00:00:00.000Z` });

    const data = (await (await summary(s.token)).json()) as {
      models: Array<{ alias: string | null; spent_micros: number }>;
    };
    expect(data.models.find((m) => m.alias === 'noul')?.spent_micros).toBe(
      100,
    );
  });

  it('keeps unattributed spend out of per-alias rows but reports it', async () => {
    const repo = new UsageRepository(s.t.db);
    repo.append({
      project_id: s.projectId,
      feature: 'adhoc',
      billing_source: 'builtin',
      billing_type: 'payg',
      provider: 'ark',
      model: 'doubao-seed-1-6-250615',
      assignment_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: null,
      quantity: null,
      http_status: 200,
      cached: false,
      cost_micros: 555,
      ts: new Date().toISOString(),
    });

    const data = (await (await summary(s.token)).json()) as {
      models: Array<{ spent_micros: number }>;
      unassigned_spent_micros: number;
    };
    expect(data.models.every((m) => m.spent_micros === 0)).toBe(true);
    expect(data.unassigned_spent_micros).toBe(555);
  });

  it('never counts byok spend against budgets', async () => {
    await report({
      project: 'zeus',
      feature: 'noul',
      billing_source: 'byok',
      provider: 'ark',
      model: 'doubao-seed-1-6-250615',
      assignment_id: s.noulId,
      input_tokens: 10_000_000,
      output_tokens: 10_000_000,
      http_status: 200,
      cached: false,
      ts: new Date().toISOString(),
    });

    const data = (await (await summary(s.token)).json()) as {
      models: Array<{ spent_micros: number }>;
    };
    expect(data.models.every((m) => m.spent_micros === 0)).toBe(true);
  });
});
