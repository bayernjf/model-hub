import { describe, expect, it } from 'vitest';
import { buildKeyRing } from '../src/crypto/keyring.js';
import { ProviderRepository } from '../src/repositories/providers.js';
import { login, makeTestApp } from './helpers.js';

const validProvider = {
  name: 'Ark Plan',
  preset_id: 'ark-plan',
  protocol: 'openai-compatible',
  base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  billing_type: 'subscription',
  api_key: 'PLACEHOLDER_KEY_ark_plan_0001',
};

function jsonRequest(cookie: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

describe('providers CRUD', () => {
  it('requires authentication', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/admin/providers');
    expect(res.status).toBe(401);
  });

  it('creates a provider with an encrypted key and a mask hint', async () => {
    const { app, db } = makeTestApp();
    const cookie = await login(app);

    const res = await app.request(
      '/api/admin/providers',
      jsonRequest(cookie, {
        method: 'POST',
        body: JSON.stringify(validProvider),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      provider: {
        api_key_hint: string;
        has_api_key: boolean;
      } & Record<string, unknown>;
    };
    expect(body.provider.api_key_hint).toBe('****0001');
    expect(body.provider.has_api_key).toBe(true);
    expect(body.provider).not.toHaveProperty('api_key_cipher');

    const stored = db
      .prepare('SELECT api_key_cipher FROM providers')
      .get() as { api_key_cipher: string };
    expect(stored.api_key_cipher).toMatch(/^enc\$v1\$k1\$/);
    expect(stored.api_key_cipher).not.toContain('PLACEHOLDER');
  });

  it('lists and gets providers', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    await app.request('/api/admin/providers',
      jsonRequest(cookie, { method: 'POST', body: JSON.stringify(validProvider) }));

    const list = await app.request('/api/admin/providers', { headers: { Cookie: cookie } });
    const listBody = (await list.json()) as { providers: unknown[] };
    expect(listBody.providers).toHaveLength(1);

    const id = (listBody.providers[0] as { id: string }).id;
    const one = await app.request(`/api/admin/providers/${id}`, { headers: { Cookie: cookie } });
    expect(one.status).toBe(200);
  });

  it('keeps the stored key when a mask or empty value is submitted', async () => {
    const { app, db, config } = makeTestApp();
    const cookie = await login(app);
    const created = await app.request('/api/admin/providers',
      jsonRequest(cookie, { method: 'POST', body: JSON.stringify(validProvider) }));
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;
    const repo = new ProviderRepository(db, buildKeyRing(config.masterKey));

    for (const submitted of ['****0001', '']) {
      await app.request(`/api/admin/providers/${id}`,
        jsonRequest(cookie, {
          method: 'PATCH',
          body: JSON.stringify({ api_key: submitted }),
        }));
      expect(repo.revealKey(id)).toBe('PLACEHOLDER_KEY_ark_plan_0001');
    }
  });

  it('re-seals the key when a new non-masked value is submitted', async () => {
    const { app, db, config } = makeTestApp();
    const cookie = await login(app);
    const created = await app.request('/api/admin/providers',
      jsonRequest(cookie, { method: 'POST', body: JSON.stringify(validProvider) }));
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;

    const res = await app.request(`/api/admin/providers/${id}`,
      jsonRequest(cookie, {
        method: 'PATCH',
        body: JSON.stringify({ api_key: 'PLACEHOLDER_KEY_ark_rotated_9999' }),
      }));
    const body = (await res.json()) as { provider: { api_key_hint: string } };
    expect(body.provider.api_key_hint).toBe('****9999');

    const repo = new ProviderRepository(db, buildKeyRing(config.masterKey));
    expect(repo.revealKey(id)).toBe('PLACEHOLDER_KEY_ark_rotated_9999');
  });

  it('rejects invalid protocol or base_url with 400', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);

    const badProtocol = await app.request('/api/admin/providers',
      jsonRequest(cookie, {
        method: 'POST',
        body: JSON.stringify({ ...validProvider, protocol: 'bogus' }),
      }));
    expect(badProtocol.status).toBe(400);

    const badUrl = await app.request('/api/admin/providers',
      jsonRequest(cookie, {
        method: 'POST',
        body: JSON.stringify({ ...validProvider, base_url: 'not-a-url' }),
      }));
    expect(badUrl.status).toBe(400);
  });

  it('deletes a provider', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const created = await app.request('/api/admin/providers',
      jsonRequest(cookie, { method: 'POST', body: JSON.stringify(validProvider) }));
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;

    const res = await app.request(`/api/admin/providers/${id}`,
      jsonRequest(cookie, { method: 'DELETE' }));
    expect(res.status).toBe(200);

    const list = await app.request('/api/admin/providers', { headers: { Cookie: cookie } });
    expect((await list.json() as { providers: unknown[] }).providers).toHaveLength(0);
  });
});
