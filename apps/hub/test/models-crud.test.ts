import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { makeTestApp, login, type TestApp } from './helpers.js';

async function createProvider(
  app: TestApp['app'],
  cookie: string,
  extra: Record<string, unknown> = {},
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
      ...extra,
    }),
  });
  const data = (await res.json()) as { provider: { id: string } };
  return data.provider.id;
}

async function importOne(
  app: TestApp['app'],
  cookie: string,
  pid: string,
  modelId: string,
): Promise<string> {
  const res = await app.request(`/api/admin/providers/${pid}/models/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ preset_provider_id: 'ark', model_ids: [modelId] }),
  });
  const data = (await res.json()) as { imported: Array<{ id: string }> };
  return data.imported[0]?.id ?? '';
}

describe('model management', () => {
  let t: TestApp;
  let cookie: string;

  beforeEach(async () => {
    t = makeTestApp();
    cookie = await login(t.app);
  });

  it('returns the preset catalog', async () => {
    const res = await t.app.request('/api/admin/presets', {
      headers: { Cookie: cookie },
    });
    const data = (await res.json()) as {
      catalog_version: string;
      presets: unknown[];
    };
    expect(data.catalog_version).toBeTruthy();
    expect(data.presets.length).toBe(6);
  });

  it('imports preset models disabled by default', async () => {
    const pid = await createProvider(t.app, cookie);
    const res = await t.app.request(
      `/api/admin/providers/${pid}/models/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          preset_provider_id: 'ark',
          model_ids: ['seedream-5-0-pro', 'seedance-2-5'],
        }),
      },
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      imported: Array<{ enabled: boolean }>;
    };
    expect(data.imported.length).toBe(2);
    expect(data.imported.every((m) => m.enabled === false)).toBe(true);

    const list = await t.app.request(`/api/admin/providers/${pid}/models`, {
      headers: { Cookie: cookie },
    });
    const listed = (await list.json()) as { models: unknown[] };
    expect(listed.models.length).toBe(2);
  });

  it('skips already imported and unknown model ids', async () => {
    const pid = await createProvider(t.app, cookie);
    const doImport = (modelIds: string[]) =>
      t.app.request(`/api/admin/providers/${pid}/models/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ preset_provider_id: 'ark', model_ids: modelIds }),
      });

    await doImport(['seedream-5-0-pro']);
    const res = await doImport(['seedream-5-0-pro', 'nope']);
    const data = (await res.json()) as {
      imported: unknown[];
      skipped: string[];
    };
    expect(data.imported.length).toBe(0);
    expect(data.skipped.sort()).toEqual(['nope', 'seedream-5-0-pro']);
  });

  it('rejects an unknown preset provider', async () => {
    const pid = await createProvider(t.app, cookie);
    const res = await t.app.request(
      `/api/admin/providers/${pid}/models/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ preset_provider_id: 'nope', model_ids: ['x'] }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('creates a manual model', async () => {
    const pid = await createProvider(t.app, cookie);
    const res = await t.app.request(`/api/admin/providers/${pid}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'my-model',
        display_name: 'My Model',
        modalities: ['text'],
        enabled: true,
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      model: { model: string; enabled: boolean };
    };
    expect(data.model.model).toBe('my-model');
    expect(data.model.enabled).toBe(true);
  });

  it('rejects a duplicate manual model', async () => {
    const pid = await createProvider(t.app, cookie);
    const body = JSON.stringify({
      model: 'my-model',
      display_name: 'My Model',
      modalities: ['text'],
    });
    const post = () =>
      t.app.request(`/api/admin/providers/${pid}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body,
      });
    await post();
    const res = await post();
    expect(res.status).toBe(400);
  });

  it('applies an overlay patch to allow-listed fields', async () => {
    const pid = await createProvider(t.app, cookie);
    const mid = await importOne(t.app, cookie, pid, 'seedream-5-0-pro');
    const res = await t.app.request(`/api/admin/models/${mid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        enabled: true,
        pricing: { per_image: 0.05 },
        sort_order: 3,
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      model: {
        enabled: boolean;
        pricing: { per_image: number };
        sort_order: number;
      };
    };
    expect(data.model.enabled).toBe(true);
    expect(data.model.pricing.per_image).toBe(0.05);
    expect(data.model.sort_order).toBe(3);
  });

  it('rejects credential and dialect fields in the overlay', async () => {
    const pid = await createProvider(t.app, cookie);
    const mid = await importOne(t.app, cookie, pid, 'seedream-5-0-pro');
    const forbidden = [
      { model: 'hacked' },
      { api_key: 'x' },
      { base_url: 'http://evil' },
      { adapter: { submit_path: '/x' } },
      { endpoints: { chat: '/x' } },
      { litellm_id: 'x/x' },
    ];
    for (const patch of forbidden) {
      const res = await t.app.request(`/api/admin/models/${mid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
    }
  });

  it('deletes a model', async () => {
    const pid = await createProvider(t.app, cookie);
    const mid = await importOne(t.app, cookie, pid, 'seedream-5-0-pro');
    const res = await t.app.request(`/api/admin/models/${mid}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const list = await t.app.request(`/api/admin/providers/${pid}/models`, {
      headers: { Cookie: cookie },
    });
    const listed = (await list.json()) as { models: unknown[] };
    expect(listed.models.length).toBe(0);
  });

  it('forbids operator from writing models', async () => {
    const pid = await createProvider(t.app, cookie);
    const opCookie = await login(t.app, 'operator', 'operator-password-123');
    const res = await t.app.request(
      `/api/admin/providers/${pid}/models/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: opCookie },
        body: JSON.stringify({
          preset_provider_id: 'ark',
          model_ids: ['seedream-5-0-pro'],
        }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('L1 provider test route', () => {
  let t: TestApp;
  let cookie: string;

  beforeEach(async () => {
    t = makeTestApp();
    cookie = await login(t.app);
  });
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = () =>
    new Response(JSON.stringify({ choices: [{}], model: 'auto' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('runs an L1 test and returns the result', async () => {
    const pid = await createProvider(t.app, cookie, { api_key: 'sk-real' });
    const mockFetch = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', mockFetch);
    const res = await t.app.request(`/api/admin/providers/${pid}/test`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns an error when no key is configured', async () => {
    const pid = await createProvider(t.app, cookie);
    const res = await t.app.request(`/api/admin/providers/${pid}/test`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const data = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe('unauthorized');
  });

  it('enforces the 20/hour rate limit', async () => {
    const pid = await createProvider(t.app, cookie, { api_key: 'sk-real' });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    for (let i = 0; i < 20; i++) {
      await t.app.request(`/api/admin/providers/${pid}/test`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
    }
    const res = await t.app.request(`/api/admin/providers/${pid}/test`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(429);
  });

  it('forbids operator from running tests', async () => {
    const pid = await createProvider(t.app, cookie, { api_key: 'sk-real' });
    const opCookie = await login(t.app, 'operator', 'operator-password-123');
    const res = await t.app.request(`/api/admin/providers/${pid}/test`, {
      method: 'POST',
      headers: { Cookie: opCookie },
    });
    expect(res.status).toBe(403);
  });
});

describe('L2 model test persistence', () => {
  let t: TestApp;
  let cookie: string;

  beforeEach(async () => {
    t = makeTestApp();
    cookie = await login(t.app);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function importModel(apiKey?: string): Promise<string> {
    const pid = await createProvider(
      t.app,
      cookie,
      apiKey === undefined ? {} : { api_key: apiKey },
    );
    const res = await t.app.request(
      `/api/admin/providers/${pid}/models/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          preset_provider_id: 'ark',
          model_ids: ['doubao-seed-1-6'],
        }),
      },
    );
    return (
      (await res.json()) as { imported: Array<{ id: string }> }
    ).imported[0]?.id ?? '';
  }

  async function lastTests(): Promise<
    Record<string, { ok: boolean; error_code: string | null }>
  > {
    const res = await t.app.request('/api/admin/models', {
      headers: { Cookie: cookie },
    });
    return ((await res.json()) as { last_tests: Record<string, never> })
      .last_tests;
  }

  it('records a failed probe and surfaces it on GET /models', async () => {
    const id = await importModel('sk-real');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"code":"boom"}}', { status: 500 })),
    );
    const res = await t.app.request(`/api/admin/models/${id}/test`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);

    const tests = await lastTests();
    expect(tests[id]?.ok).toBe(false);
    expect(tests[id]?.error_code).toBeTruthy();
  });

  it('records a successful probe', async () => {
    const id = await importModel('sk-real');
    // L2 compares the model echo against the configured model string, so the
    // stub echoes back whatever the probe sent.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as { model?: string };
        return new Response(
          JSON.stringify({ choices: [{}], model: body.model ?? 'auto' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const res = await t.app.request(`/api/admin/models/${id}/test`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const tests = await lastTests();
    expect(tests[id]?.ok).toBe(true);
    expect(tests[id]?.error_code).toBeNull();
  });

  it('records unauthorized when the provider has no key', async () => {
    const id = await importModel();
    const res = await t.app.request(`/api/admin/models/${id}/test`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);

    const tests = await lastTests();
    expect(tests[id]?.error_code).toBe('unauthorized');
  });
});
