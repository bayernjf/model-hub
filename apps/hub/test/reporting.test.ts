import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';
import { UsageRepository } from '../src/repositories/reporting.js';

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
  const provider = (await provRes.json()) as {
    provider: { id: string };
  };

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

  // Enable the model.
  await t.app.request(`/api/admin/models/${modelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ enabled: true }),
  });

  // Project.
  const prjRes = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug: 'zeus', display_name: 'Zeus' }),
  });
  const project = (await prjRes.json()) as {
    project: { id: string };
  };
  const projectId = project.project.id;

  // Token.
  const tokRes = await t.app.request(
    `/api/admin/projects/${projectId}/rotate-token`,
    { method: 'POST', headers: { Cookie: cookie } },
  );
  const token = (await tokRes.json()) as { token: string };

  // Assign the model with an alias.
  const asnRes = await t.app.request('/api/admin/assignments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      project_id: projectId,
      assignments: [{ model_id: modelId, alias: 'noul' }],
    }),
  });
  const assignments = (await asnRes.json()) as {
    assignments: Array<{ id: string }>;
  };
  const assignmentId = assignments.assignments[0]?.id ?? '';

  return {
    t,
    cookie,
    projectId,
    token: token.token,
    modelId,
    assignmentId,
  };
}

const now = () => new Date().toISOString();

describe('usage reporting', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  async function report(body: unknown) {
    return s.t.app.request('/pub/v1/usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  const validUsage = {
    project: 'zeus',
    feature: 'noul',
    billing_source: 'builtin',
    billing_type: 'payg',
    provider: 'ark',
    model: 'doubao-seed-1-6-250615',
    assignment_id: 'placeholder',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    reasoning_tokens: 100,
    http_status: 200,
    cached: false,
    ts: now(),
  };

  it('rejects a missing token', async () => {
    const res = await s.t.app.request('/pub/v1/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validUsage),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body', async () => {
    const res = await report({ project: 'zeus' });
    expect(res.status).toBe(400);
  });

  it('accepts builtin usage and computes cost', async () => {
    const body = { ...validUsage, assignment_id: s.assignmentId };
    const res = await report(body);
    expect(res.status).toBe(200);

    // Read back via the repository to verify cost and reasoning tokens.
    const usageRepo = new UsageRepository(s.t.db);
    const events = usageRepo.listByProject(s.projectId);
    expect(events).toHaveLength(1);
    expect(events[0]?.assignment_id).toBe(s.assignmentId);
    expect(events[0]?.reasoning_tokens).toBe(100);
    expect(events[0]?.cost_micros).not.toBeNull();
    expect(events[0]?.cost_micros ?? 0).toBeGreaterThan(0);
  });

  it('records null cost for byok usage', async () => {
    const res = await report({
      ...validUsage,
      billing_source: 'byok',
      assignment_id: s.assignmentId,
    });
    expect(res.status).toBe(200);
    const usageRepo = new UsageRepository(s.t.db);
    const events = usageRepo.listByProject(s.projectId);
    expect(events[0]?.cost_micros).toBeNull();
  });

  it('ignores a forged assignment id', async () => {
    const res = await report({
      ...validUsage,
      assignment_id: 'asn_forged0000000000000000000',
    });
    expect(res.status).toBe(200);
    const usageRepo = new UsageRepository(s.t.db);
    const events = usageRepo.listByProject(s.projectId);
    expect(events[0]?.assignment_id).toBeNull();
  });
});

describe('health-check reporting', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  async function report(body: unknown) {
    return s.t.app.request('/pub/v1/health-checks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  const validHealth = {
    project: 'zeus',
    assignment_id: null,
    alias: 'noul',
    level: 'L4',
    ok: true,
    latency_ms: 320,
    ts: now(),
  };

  it('accepts a valid health report', async () => {
    const res = await report({
      ...validHealth,
      assignment_id: s.assignmentId,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { accepted: boolean };
    expect(data.accepted).toBe(true);
  });

  it('rejects an invalid level', async () => {
    const res = await report({ ...validHealth, level: 'L9' });
    expect(res.status).toBe(400);
  });

  it('accepts a failed report with an error', async () => {
    const res = await report({
      ...validHealth,
      ok: false,
      error: { code: 'timeout', hint: '15s exceeded' },
    });
    expect(res.status).toBe(200);
  });
});
