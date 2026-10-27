import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('health endpoint', () => {
  it('returns 200 ok payload on GET /healthz', async () => {
    const app = createApp();
    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      version: string;
      uptime_s: number;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('model-hub');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 with a structured error for unknown routes', async () => {
    const app = createApp();
    const res = await app.request('/does-not-exist');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
