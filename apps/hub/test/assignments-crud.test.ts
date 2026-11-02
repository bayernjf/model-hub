import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, login, type TestApp } from './helpers.js';

async function createProvider(
  app: TestApp['app'],
  cookie: string,
): Promise<string> {
  const res = await app.request('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name: 'Ark',
      preset_id: 'ark',
      protocol: 'openai-compatible',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      billing_type: 'payg',
    }),
  });
  const data = (await res.json()) as { provider: { id: string } };
  return data.provider.id;
}

async function importModel(
  app: TestApp['app'],
  cookie: string,
  pid: string,
  modelId: string,
): Promise<string> {
  const res = await app.request(
    `/api/admin/providers/${pid}/models/import`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        preset_provider_id: 'ark',
        model_ids: [modelId],
      }),
    },
  );
  const data = (await res.json()) as { imported: Array<{ id: string }> };
  return data.imported[0]?.id ?? '';
}

async function createProject(
  app: TestApp['app'],
  cookie: string,
  slug: string,
): Promise<string> {
  const res = await app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug, display_name: slug }),
  });
  const data = (await res.json()) as { project: { id: string } };
  return data.project.id;
}

describe('assignment management', () => {
  let t: TestApp;
  let cookie: string;
  let pid: string;
  let mid: string;
  let prj: string;

  beforeEach(async () => {
    t = makeTestApp();
    cookie = await login(t.app);
    pid = await createProvider(t.app, cookie);
    mid = await importModel(
      t.app,
      cookie,
      pid,
      'doubao-seed-1-6',
    );
    prj = await createProject(t.app, cookie, 'zeus');
  });

  async function put(body: unknown, c: string = cookie) {
    return t.app.request('/api/admin/assignments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: c },
      body: JSON.stringify(body),
    });
  }

  it('rejects unauthenticated requests', async () => {
    const res = await t.app.request('/api/admin/assignments');
    expect(res.status).toBe(401);
  });

  it('assigns a batch and returns it', async () => {
    const res = await put({
      project_id: prj,
      assignments: [
        {
          model_id: mid,
          role: 'primary',
          alias: 'noul',
          daily_budget_micros: 5_000_000,
        },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      assignments: Array<{
        alias: string;
        role: string;
        daily_budget_micros: number;
      }>;
    };
    expect(data.assignments).toHaveLength(1);
    expect(data.assignments[0]?.alias).toBe('noul');
    expect(data.assignments[0]?.daily_budget_micros).toBe(5_000_000);
  });

  it('lists assignments scoped to a project', async () => {
    await put({ project_id: prj, assignments: [{ model_id: mid }] });
    const res = await t.app.request(
      `/api/admin/assignments?project=${prj}`,
      { headers: { Cookie: cookie } },
    );
    const data = (await res.json()) as { assignments: unknown[] };
    expect(data.assignments).toHaveLength(1);
  });

  it('replaces the whole set on a second batch', async () => {
    const mid2 = await importModel(
      t.app,
      cookie,
      pid,
      'doubao-seed-evolving',
    );
    await put({ project_id: prj, assignments: [{ model_id: mid }] });
    await put({ project_id: prj, assignments: [{ model_id: mid2 }] });

    const res = await t.app.request(
      `/api/admin/assignments?project=${prj}`,
      { headers: { Cookie: cookie } },
    );
    const data = (await res.json()) as {
      assignments: Array<{ model_id: string }>;
    };
    expect(data.assignments).toHaveLength(1);
    expect(data.assignments[0]?.model_id).toBe(mid2);
  });

  it('clears assignments with an empty batch', async () => {
    await put({ project_id: prj, assignments: [{ model_id: mid }] });
    await put({ project_id: prj, assignments: [] });
    const res = await t.app.request(
      `/api/admin/assignments?project=${prj}`,
      { headers: { Cookie: cookie } },
    );
    const data = (await res.json()) as { assignments: unknown[] };
    expect(data.assignments).toHaveLength(0);
  });

  it('rejects a duplicate alias', async () => {
    const mid2 = await importModel(
      t.app,
      cookie,
      pid,
      'doubao-seed-evolving',
    );
    const res = await put({
      project_id: prj,
      assignments: [
        { model_id: mid, alias: 'noul' },
        { model_id: mid2, alias: 'noul' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('rejects the same model twice', async () => {
    const res = await put({
      project_id: prj,
      assignments: [{ model_id: mid }, { model_id: mid }],
    });
    expect(res.status).toBe(400);
  });

  it('allows the same model under distinct aliases', async () => {
    const res = await put({
      project_id: prj,
      assignments: [
        { model_id: mid, alias: 'noul' },
        { model_id: mid, alias: 'choice' },
        { model_id: mid, alias: 'score' },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      assignments: Array<{ model_id: string; alias: string }>;
    };
    expect(data.assignments).toHaveLength(3);
    expect(data.assignments.map((a) => a.alias)).toEqual([
      'noul',
      'choice',
      'score',
    ]);
    expect(
      data.assignments.every((a) => a.model_id === mid),
    ).toBe(true);
  });

  it('rejects an aliased row after an alias-less row of the same model', async () => {
    const res = await put({
      project_id: prj,
      assignments: [
        { model_id: mid },
        { model_id: mid, alias: 'noul' },
      ],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      error: { code: string };
    };
    expect(data.error.code).toBe('duplicate_model');
  });

  it('rejects an unknown model', async () => {
    const res = await put({
      project_id: prj,
      assignments: [{ model_id: 'mdl_doesnotexist' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown project', async () => {
    const res = await put({
      project_id: 'prj_doesnotexist',
      assignments: [{ model_id: mid }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid role', async () => {
    const res = await put({
      project_id: prj,
      assignments: [{ model_id: mid, role: 'boss' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a negative budget', async () => {
    const res = await put({
      project_id: prj,
      assignments: [{ model_id: mid, daily_budget_micros: -1 }],
    });
    expect(res.status).toBe(400);
  });

  it('lets operator read but not write', async () => {
    const opCookie = await login(
      t.app,
      'operator',
      'operator-password-123',
    );
    const getRes = await t.app.request('/api/admin/assignments', {
      headers: { Cookie: opCookie },
    });
    expect(getRes.status).toBe(200);

    const putRes = await put(
      { project_id: prj, assignments: [{ model_id: mid }] },
      opCookie,
    );
    expect(putRes.status).toBe(403);
  });
});
