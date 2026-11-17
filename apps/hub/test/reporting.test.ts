import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';
import {
  UsageRepository,
  type UsageEventInsert,
} from '../src/repositories/reporting.js';

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

  it('persists optional org dimensions and leaves them NULL when absent', async () => {
    await report({
      ...validUsage,
      assignment_id: s.assignmentId,
      position_id: 'pos_0001',
      department_id: 'dep_0001',
      task_id: 'task_0001',
    });
    await report({ ...validUsage, assignment_id: s.assignmentId });

    const events = new UsageRepository(s.t.db).listByProject(s.projectId);
    expect(events).toHaveLength(2);
    const attributed = events.find((e) => e.task_id !== null);
    expect(attributed?.position_id).toBe('pos_0001');
    expect(attributed?.department_id).toBe('dep_0001');
    expect(attributed?.task_id).toBe('task_0001');
    const plain = events.find((e) => e.task_id === null);
    expect(plain?.position_id).toBeNull();
    expect(plain?.department_id).toBeNull();
  });

  it('persists the degraded flag, defaulting to false', async () => {
    await report({ ...validUsage, assignment_id: s.assignmentId, degraded: true });
    await report({ ...validUsage, assignment_id: s.assignmentId });
    const usageRepo = new UsageRepository(s.t.db);
    const events = usageRepo.listByProject(s.projectId);
    expect(events).toHaveLength(2);
    const flagged = events.filter((e) => e.degraded);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.model).toBe(validUsage.model);
  });
});

describe('usage aggregation', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  function appendEvent(overrides: Partial<UsageEventInsert> & { ts: string }) {
    const repo = new UsageRepository(s.t.db);
    repo.append({
      project_id: s.projectId,
      feature: 'noul',
      billing_source: 'builtin',
      billing_type: 'payg',
      provider: 'ark',
      model: 'doubao-seed-1-6-250615',
      assignment_id: s.assignmentId,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      reasoning_tokens: null,
      quantity: null,
      http_status: 200,
      cached: false,
      cost_micros: 1234,
      ...overrides,
    });
  }

  it('sums reasoning and cache-read tokens, treating NULL reasoning as zero', () => {
    appendEvent({
      ts: '2026-10-28T10:00:00.000Z',
      reasoning_tokens: 120,
      cache_read_tokens: 30,
    });
    appendEvent({
      ts: '2026-10-28T11:00:00.000Z',
      reasoning_tokens: null,
      cache_read_tokens: 20,
    });

    const rows = new UsageRepository(s.t.db).aggregate();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reasoning_tokens).toBe(120);
    expect(rows[0]?.cache_read_tokens).toBe(50);
    expect(rows[0]?.calls).toBe(2);
  });

  it('applies an inclusive from/to window', () => {
    appendEvent({ ts: '2026-10-26T08:00:00.000Z' });
    appendEvent({ ts: '2026-10-27T09:00:00.000Z' });
    appendEvent({ ts: '2026-10-28T10:00:00.000Z' });

    const repo = new UsageRepository(s.t.db);
    expect(repo.aggregate()).toHaveLength(3);

    const windowed = repo.aggregate({
      from: '2026-10-27T00:00:00.000Z',
      to: '2026-10-27T23:59:59.999Z',
    });
    expect(windowed).toHaveLength(1);
    expect(windowed[0]?.day).toBe('2026-10-27');

    expect(
      repo.aggregate({ from: '2026-10-27T00:00:00.000Z' }),
    ).toHaveLength(2);
    expect(repo.aggregate({ to: '2026-10-26T23:59:59.999Z' })).toHaveLength(1);
  });

  it('keeps the project aggregation unchanged when org dimensions are set', () => {
    appendEvent({
      ts: '2026-10-28T10:00:00.000Z',
      position_id: 'pos-1',
      department_id: 'dep-1',
      task_id: 'task-1',
    });
    appendEvent({ ts: '2026-10-28T11:00:00.000Z' });

    const rows = new UsageRepository(s.t.db).aggregate();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.calls).toBe(2);
    expect(rows[0]?.cost_micros).toBe(2468);
  });

  it('aggregates cost by task, position and department (M3 F3.3)', () => {
    const attributed = {
      position_id: 'pos-1',
      department_id: 'dep-1',
    };
    appendEvent({ ts: '2026-10-28T10:00:00.000Z', task_id: 'task-1', ...attributed, cost_micros: 1200 });
    appendEvent({ ts: '2026-10-28T11:00:00.000Z', task_id: 'task-1', ...attributed, cost_micros: 800 });
    appendEvent({ ts: '2026-10-28T12:00:00.000Z', task_id: 'task-2', position_id: 'pos-2', department_id: 'dep-1', cost_micros: 500 });
    // Unattributed row: must be excluded from every org facet.
    appendEvent({ ts: '2026-10-28T13:00:00.000Z' });

    const repo = new UsageRepository(s.t.db);
    const byTask = repo.aggregateByOrg('task');
    expect(byTask).toHaveLength(2);
    expect(byTask[0]).toMatchObject({
      key: 'task-1',
      calls: 2,
      input_tokens: 200,
      output_tokens: 100,
      cost_micros: 2000,
    });
    expect(byTask[1]).toMatchObject({ key: 'task-2', calls: 1, cost_micros: 500 });

    const byDept = repo.aggregateByOrg('department');
    expect(byDept).toHaveLength(1);
    expect(byDept[0]).toMatchObject({ key: 'dep-1', calls: 3, cost_micros: 2500 });

    const byPosition = repo.aggregateByOrg('position');
    expect(byPosition).toHaveLength(2);

    // The window applies to the org facets too.
    const windowed = repo.aggregateByOrg('task', {
      from: '2026-10-28T11:00:00.000Z',
    });
    expect(windowed).toHaveLength(2);
    expect(windowed.find((r) => r.key === 'task-1')?.cost_micros).toBe(800);
  });

  it('counts usage whose project is not registered instead of dropping it', () => {
    appendEvent({ ts: '2026-10-27T09:00:00.000Z' });

    // Usage written with a project id that has no projects row — a deleted
    // project, or a client sending its own label. The aggregate joins on
    // projects, so this row disappears from every total with no trace.
    s.t.db
      .prepare(
        `INSERT INTO usage_events (id, project_id, feature, billing_source, provider,
           model, input_tokens, output_tokens, cache_read_tokens, http_status, cached,
           cost_micros, ts, created_at)
         VALUES ('u-orphan', 'p-vanished', 'chat', 'builtin', 'ark',
           'doubao-seed-1-6', 10, 20, 0, 200, 0, 5000,
           '2026-10-27T09:00:00.000Z', '2026-10-27T09:00:00.000Z')`,
      )
      .run();

    const repo = new UsageRepository(s.t.db);
    expect(repo.aggregate()).toHaveLength(1);
    expect(repo.unattributedRows()).toBe(1);
    expect(
      repo.unattributedRows({ from: '2026-10-28T00:00:00.000Z' }),
    ).toBe(0);
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
