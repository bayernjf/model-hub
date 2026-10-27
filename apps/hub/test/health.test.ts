import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrateUp } from '../src/db/migrate.js';
import { openDatabase } from '../src/db/open.js';

describe('health endpoints', () => {
  it('returns 200 ok payload on GET /healthz', async () => {
    const db = openDatabase(':memory:');
    const app = createApp(db);
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

  it('returns ready on GET /readyz when the database is reachable', async () => {
    const db = openDatabase(':memory:');
    migrateUp(db);
    const app = createApp(db);
    const res = await app.request('/readyz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(true);
  });

  it('returns 404 with a structured error for unknown routes', async () => {
    const db = openDatabase(':memory:');
    const app = createApp(db);
    const res = await app.request('/does-not-exist');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
