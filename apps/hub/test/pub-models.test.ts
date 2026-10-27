import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';

async function setup() {
  const t = makeTestApp();
  const cookie = await login(t.app);

  // Provider with a real key.
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
  const providerId = provider.provider.id;

  // Import a model.
  const importRes = await t.app.request(
    `/api/admin/providers/${providerId}/models/import`,
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
  const model = imported.imported[0]?.id ?? '';

  // Project and token.
  const prjRes = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug: 'zeus', display_name: 'Zeus' }),
  });
  const project = (await prjRes.json()) as {
    project: { id: string };
  };
  const projectId = project.project.id;

  const tokRes = await t.app.request(
    `/api/admin/projects/${projectId}/rotate-token`,
    { method: 'POST', headers: { Cookie: cookie } },
  );
  const token = (await tokRes.json()) as { token: string };

  return {
    t,
    cookie,
    provider: providerId,
    model,
    project: projectId,
    token: token.token,
  };
}

describe('project-facing catalog', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  async function pull(headers: Record<string, string> = {}) {
    return s.t.app.request('/pub/v1/models', {
      headers: { Authorization: `Bearer ${s.token}`, ...headers },
    });
  }

  it('rejects a missing bearer token', async () => {
    const res = await s.t.app.request('/pub/v1/models');
    expect(res.status).toBe(401);
  });

  it('rejects a bad token', async () => {
    const res = await s.t.app.request('/pub/v1/models', {
      headers: { Authorization: 'Bearer mh_wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the projected model with decrypted key', async () => {
    // The imported model is disabled by default; assign it (which the
    // assignment UI does after enabling) — enable it first.
    await s.t.app.request(`/api/admin/models/${s.model}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({ enabled: true }),
    });
    await s.t.app.request('/api/admin/assignments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({
        project_id: s.project,
        assignments: [{ model_id: s.model, alias: 'noul' }],
      }),
    });

    const res = await pull();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      project: string;
      revision: number;
      models: Array<{
        alias: string;
        api_key: string;
        base_url: string;
        endpoints: { chat?: string };
      }>;
    };
    expect(data.project).toBe('zeus');
    expect(data.models).toHaveLength(1);
    expect(data.models[0]?.alias).toBe('noul');
    expect(data.models[0]?.api_key).toBe('vendor-secret-key');
    expect(data.models[0]?.endpoints.chat).toBe('/chat/completions');
  });

  it('excludes a disabled model', async () => {
    await s.t.app.request(`/api/admin/models/${s.model}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({ enabled: true }),
    });
    await s.t.app.request('/api/admin/assignments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({
        project_id: s.project,
        assignments: [{ model_id: s.model }],
      }),
    });
    // Disable the model after assignment.
    await s.t.app.request(`/api/admin/models/${s.model}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({ enabled: false }),
    });

    const res = await pull();
    const data = (await res.json()) as { models: unknown[] };
    expect(data.models).toHaveLength(0);
  });

  it('answers 304 when the ETag matches', async () => {
    const first = await pull();
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const res = await pull({ 'If-None-Match': etag ?? '' });
    expect(res.status).toBe(304);
  });

  it('bumps the revision after a write', async () => {
    const before = await pull();
    const beforeData = (await before.json()) as { revision: number };

    await s.t.app.request('/api/admin/assignments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({ project_id: s.project, assignments: [] }),
    });

    const after = await pull();
    const afterData = (await after.json()) as { revision: number };
    expect(afterData.revision).toBeGreaterThan(beforeData.revision);
  });
});
