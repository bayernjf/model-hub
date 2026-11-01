import { describe, expect, it } from 'vitest';
import { login, makeTestApp } from './helpers.js';

// Provider key pool end-to-end through the Hono app: admin CRUD/ordering and
// the project-facing key-events cooldown endpoint + projected api_keys.
async function bootstrap() {
  const t = makeTestApp();
  const cookie = await login(t.app);
  const hdr = { 'Content-Type': 'application/json', Cookie: cookie };

  const prov = await t.app.request('/api/admin/providers', {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({
      name: 'Ark',
      preset_id: 'ark',
      protocol: 'openai-compatible',
      base_url: 'https://ark/v3',
      api_key: 'vendor-key-A',
    }),
  });
  const providerId = ((await prov.json()) as { provider: { id: string } }).provider.id;

  // Second pool key.
  const add2 = await t.app.request(`/api/admin/providers/${providerId}/keys`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ label: 'plan-B', api_key: 'vendor-key-B' }),
  });
  expect(add2.status).toBe(201);

  const importRes = await t.app.request(`/api/admin/providers/${providerId}/models/import`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ preset_provider_id: 'ark', model_ids: ['doubao-seed-1-6'] }),
  });
  const modelId = ((await importRes.json()) as { imported: Array<{ id: string }> }).imported[0]!.id;
  await t.app.request(`/api/admin/models/${modelId}`, {
    method: 'PATCH',
    headers: hdr,
    body: JSON.stringify({ enabled: true }),
  });

  const project = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ slug: 'zeus', display_name: 'Zeus' }),
  });
  const projectId = ((await project.json()) as { project: { id: string } }).project.id;
  await t.app.request('/api/admin/assignments', {
    method: 'PUT',
    headers: hdr,
    body: JSON.stringify({ project_id: projectId, assignments: [{ model_id: modelId, alias: 'text' }] }),
  });
  const tokenRes = await t.app.request(`/api/admin/projects/${projectId}/rotate-token`, {
    method: 'POST',
    headers: hdr,
  });
  const token = ((await tokenRes.json()) as { token: string }).token;

  return { t, cookie, hdr, providerId, projectId, token };
}

describe('provider key admin + projection', () => {
  it('requires admin for the key routes', async () => {
    const { t, providerId } = await bootstrap();
    const res = await t.app.request(`/api/admin/providers/${providerId}/keys`);
    expect(res.status).toBe(401);
  });

  it('projects both pool keys in seq order, then only the active/uncooled ones', async () => {
    const { t, hdr, providerId, token } = await bootstrap();
    const list = await t.app.request(`/api/admin/providers/${providerId}/keys`, { headers: { Cookie: hdr.Cookie } });
    const keys = ((await list.json()) as { keys: Array<{ id: string; label: string }> }).keys;
    expect(keys).toHaveLength(2);

    const pull = async () =>
      t.app.request('/pub/v1/models', { headers: { Authorization: `Bearer ${token}` } });
    let data = (await (await pull()).json()) as {
      models: Array<{ api_key: string; api_keys: Array<{ key: string; keyId: string }> }>;
    };
    expect(data.models[0]?.api_keys.map((k) => k.key)).toEqual(['vendor-key-A', 'vendor-key-B']);
    expect(data.models[0]?.api_key).toBe('vendor-key-A');

    // Disable the first key; the last-active guard must not block (2 active).
    const disable = await t.app.request(`/api/admin/providers/${providerId}/keys/${keys[0]!.id}`, {
      method: 'PATCH',
      headers: hdr,
      body: JSON.stringify({ is_active: false }),
    });
    expect(disable.status).toBe(200);
    data = (await (await pull()).json()) as typeof data;
    expect(data.models[0]?.api_keys.map((k) => k.key)).toEqual(['vendor-key-B']);

    // Re-enable.
    await t.app.request(`/api/admin/providers/${providerId}/keys/${keys[0]!.id}`, {
      method: 'PATCH',
      headers: hdr,
      body: JSON.stringify({ is_active: true }),
    });
  });

  it('refuses to delete the last active key with 409', async () => {
    const { t, hdr, providerId } = await bootstrap();
    let list = await t.app.request(`/api/admin/providers/${providerId}/keys`, { headers: { Cookie: hdr.Cookie } });
    let keys = ((await list.json()) as { keys: Array<{ id: string }> }).keys;
    const del2 = await t.app.request(`/api/admin/providers/${providerId}/keys/${keys[1]!.id}`, {
      method: 'DELETE',
      headers: hdr,
    });
    expect(del2.status).toBe(200);
    const delLast = await t.app.request(`/api/admin/providers/${providerId}/keys/${keys[0]!.id}`, {
      method: 'DELETE',
      headers: hdr,
    });
    expect(delLast.status).toBe(409);
    list = await t.app.request(`/api/admin/providers/${providerId}/keys`, { headers: { Cookie: hdr.Cookie } });
    keys = ((await list.json()) as { keys: Array<{ id: string }> }).keys;
    expect(keys).toHaveLength(1);
  });
});

describe('POST /pub/v1/key-events', () => {
  it('requires a project token', async () => {
    const { t } = await bootstrap();
    const res = await t.app.request('/pub/v1/key-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_id: 'x', kind: 'recovered' }),
    });
    expect(res.status).toBe(401);
  });

  it('cools a key per provider policy and recovers it', async () => {
    const { t, hdr, providerId, token } = await bootstrap();
    const list = await t.app.request(`/api/admin/providers/${providerId}/keys`, { headers: { Cookie: hdr.Cookie } });
    const keys = ((await list.json()) as { keys: Array<{ id: string }> }).keys;

    const exhaust = await t.app.request('/pub/v1/key-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key_id: keys[0]!.id, kind: 'quota_exhausted', code: 'QuotaExceeded' }),
    });
    expect(exhaust.status).toBe(200);
    expect((await exhaust.json())).toEqual({ accepted: true });

    const findKey = async (id: string) => {
      const r = await t.app.request(`/api/admin/providers/${providerId}/keys`, { headers: { Cookie: hdr.Cookie } });
      const body = (await r.json()) as { keys: Array<{ id: string; status: string; cooled_until: string | null }> };
      return body.keys.find((k) => k.id === id)!;
    };
    const view = await findKey(keys[0]!.id);
    expect(view.status).toBe('quota_exhausted');
    // default policy = 5h
    expect(view.cooled_until).toBeTruthy();

    const recover = await t.app.request('/pub/v1/key-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key_id: keys[0]!.id, kind: 'recovered' }),
    });
    expect(recover.status).toBe(200);
  });

  it('rejects an out-of-scope key with 404', async () => {
    const { t, token } = await bootstrap();
    const res = await t.app.request('/pub/v1/key-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key_id: 'pkey_doesnotexist', kind: 'quota_exhausted' }),
    });
    expect(res.status).toBe(404);
  });

  it('validates the payload', async () => {
    const { t, token } = await bootstrap();
    const res = await t.app.request('/pub/v1/key-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key_id: 'x', kind: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});
