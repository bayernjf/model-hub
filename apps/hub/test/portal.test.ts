import { describe, it, expect } from 'vitest';
import { portalServices, probeService } from '../src/routes/admin/portal.js';
import { login, makeTestApp } from './helpers.js';

describe('portalServices', () => {
  it('lists the four Tier 0 core services', () => {
    const services = portalServices({});
    expect(services.map((s) => s.key)).toEqual(['model-hub', 'zeus', 'loom', 'agent-world']);
  });

  it('overrides a URL from the environment', () => {
    const services = portalServices({ HUB_PORTAL_ZEUS_URL: 'http://zeus.local/healthz' });
    expect(services.find((s) => s.key === 'zeus')?.url).toBe('http://zeus.local/healthz');
  });

  it('leaves other URLs untouched by an unrelated override', () => {
    const services = portalServices({ HUB_PORTAL_ZEUS_URL: 'http://zeus.local/healthz' });
    expect(services.find((s) => s.key === 'loom')?.url).toContain('infra-backend-1');
  });
});

describe('probeService', () => {
  const svc = { key: 'zeus', name: 'Zeus', role: '决策内核', url: 'http://zeus/healthz' };

  it('marks a 200 as healthy', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });
    const r = await probeService(svc, fetchImpl as unknown as typeof fetch, 100);
    expect(r.healthy).toBe(true);
    expect(r.status).toBe(200);
  });

  it('marks a 500 as unhealthy but keeps the status', async () => {
    const fetchImpl = async () => new Response('{}', { status: 500 });
    const r = await probeService(svc, fetchImpl as unknown as typeof fetch, 100);
    expect(r.healthy).toBe(false);
    expect(r.status).toBe(500);
  });

  it('marks a network error as unhealthy with no status', async () => {
    const fetchImpl = async () => {
      throw new Error('boom');
    };
    const r = await probeService(svc, fetchImpl as unknown as typeof fetch, 100);
    expect(r.healthy).toBe(false);
    expect(r.status).toBeNull();
  });
});

describe('GET /api/admin/portal/status', () => {
  const okFetch = async () => new Response('{}', { status: 200 });

  it('rejects anonymous callers', async () => {
    const { app } = makeTestApp({}, { portalFetch: okFetch });
    const res = await app.request('/api/admin/portal/status');
    expect(res.status).toBe(401);
  });

  it('returns all four services healthy when authed and reachable', async () => {
    const { app } = makeTestApp({}, { portalFetch: okFetch });
    const cookie = await login(app);
    const res = await app.request('/api/admin/portal/status', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checked_at: string;
      total_ms: number;
      services: Array<{ key: string; healthy: boolean; status: number | null }>;
    };
    expect(body.services).toHaveLength(4);
    expect(body.services.every((s) => s.healthy)).toBe(true);
    expect(typeof body.checked_at).toBe('string');
  });

  it('reports a failing service as unhealthy without failing the whole request', async () => {
    const flaky = async (input: unknown) => {
      const url = String(input);
      if (url.includes('zeus')) throw new Error('boom');
      return new Response('{}', { status: 200 });
    };
    const { app } = makeTestApp({}, { portalFetch: flaky as unknown as typeof fetch });
    const cookie = await login(app);
    const res = await app.request('/api/admin/portal/status', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: Array<{ key: string; healthy: boolean }>;
    };
    const zeus = body.services.find((s) => s.key === 'zeus');
    expect(zeus?.healthy).toBe(false);
    expect(body.services.filter((s) => s.healthy)).toHaveLength(3);
  });
});
