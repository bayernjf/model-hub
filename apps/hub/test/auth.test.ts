import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrateUp } from '../src/db/migrate.js';
import { openDatabase } from '../src/db/open.js';

function makeApp() {
  const config = loadConfig({
    HUB_MASTER_KEY: 'master-key-0123456789abcdef',
    HUB_ADMIN_PASSWORD: 'owner-password-123',
    HUB_OPERATOR_PASSWORD: 'operator-password-123',
  });
  const db = openDatabase(':memory:');
  migrateUp(db);
  return { app: createApp(config, db), db };
}

async function loginCookie(
  app: Hono,
  username: string,
  password: string,
): Promise<string | null> {
  const res = await app.request('/api/admin/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return null;
  return res.headers.get('Set-Cookie')?.split(';')[0] ?? null;
}

describe('admin session login', () => {
  it('logs in the owner and sets an HttpOnly cookie', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'owner-password-123' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { username: string; role: string };
    };
    expect(body.user).toEqual({ username: 'owner', role: 'owner' });

    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain('hub_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('rejects a wrong password with 401', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'nope' }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_credentials');
  });

  it('logs in the operator with read-only role', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app, 'operator', 'operator-password-123');
    expect(cookie).toBeTruthy();

    const res = await app.request('/api/admin/session', {
      headers: { Cookie: cookie ?? '' },
    });
    const body = (await res.json()) as {
      user: { username: string; role: string };
    };
    expect(body.user.role).toBe('operator');
  });
});

describe('protected admin endpoints', () => {
  it('returns 401 without a session cookie', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/session');

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns the current user after login', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app, 'owner', 'owner-password-123');
    const res = await app.request('/api/admin/session', {
      headers: { Cookie: cookie ?? '' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { username: string; role: string };
    };
    expect(body.user.username).toBe('owner');
  });

  it('rejects a forged session cookie', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/admin/session', {
      headers: { Cookie: 'hub_session=forged.payload' },
    });
    expect(res.status).toBe(401);
  });

  it('logs out and clears the cookie', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app, 'owner', 'owner-password-123');
    const res = await app.request('/api/admin/session', {
      method: 'DELETE',
      headers: { Cookie: cookie ?? '' },
    });

    expect(res.status).toBe(200);
    const cleared = res.headers.get('Set-Cookie') ?? '';
    expect(cleared).toContain('hub_session=;');
    expect(cleared).toContain('Max-Age=0');
  });
});

describe('admin audit', () => {
  it('records login success and failure', async () => {
    const { app, db } = makeApp();

    await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'owner-password-123' }),
    });
    await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'bad' }),
    });

    const rows = db
      .prepare(
        "SELECT action, result, actor FROM admin_audit WHERE action = 'admin.login' ORDER BY id",
      )
      .all() as Array<{ action: string; result: string; actor: string }>;

    expect(rows.map((r) => r.result).sort()).toEqual(['failure', 'success']);
  });
});

describe('dev-no-auth mode', () => {
  it('grants a synthetic owner session on loopback', async () => {
    const config = loadConfig({
      HUB_DEV_NO_AUTH: '1',
      HUB_MASTER_KEY: '',
      HUB_ADMIN_PASSWORD: '',
    });
    const db = openDatabase(':memory:');
    migrateUp(db);
    const app = createApp(config, db);

    const res = await app.request('/api/admin/session', {
      headers: { Host: 'localhost:8791' },
    });
    expect(res.status).toBe(200);
  });

  it('denies access on a non-loopback host', async () => {
    const config = loadConfig({
      HUB_DEV_NO_AUTH: '1',
      HUB_MASTER_KEY: '',
      HUB_ADMIN_PASSWORD: '',
    });
    const db = openDatabase(':memory:');
    const app = createApp(config, db);

    const res = await app.request('/api/admin/session', {
      headers: { Host: '10.0.0.5:8791' },
    });
    expect(res.status).toBe(401);
  });
});
