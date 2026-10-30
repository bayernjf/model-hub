import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrateUp } from '../src/db/migrate.js';
import { openDatabase } from '../src/db/open.js';
import { PersistentLoginLimiter } from '../src/login-limiter.js';

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

describe('login brute-force guard', () => {
  function attempt(
    app: Hono,
    password: string,
    forwardedFor?: string,
    username = 'owner',
  ) {
    return app.request('/api/admin/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor === undefined ? {} : { 'X-Forwarded-For': forwardedFor }),
      },
      body: JSON.stringify({ username, password }),
    });
  }

  it('locks a peer out after 10 failures and audits the denial', async () => {
    const { app, db } = makeApp();
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt(app, 'wrong', '203.0.113.7')).status).toBe(401);
    }

    const limited = await attempt(app, 'wrong', '203.0.113.7');
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');

    const denied = db
      .prepare("SELECT count(*) AS n FROM admin_audit WHERE detail = 'rate_limited'")
      .get() as { n: number };
    expect(denied.n).toBe(1);
  });

  it('does not let a caller pick its own bucket with a spoofed X-Forwarded-For', async () => {
    const { app } = makeApp();
    // Caddy appends the peer it saw, so the real address stays right-most and a
    // fresh left-hand entry per attempt must not buy a fresh budget.
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (await attempt(app, 'wrong', `198.51.100.${i}, 203.0.113.7`)).status;
    }
    expect(last).toBe(429);
  });

  it('keeps a separate bucket per real peer', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 10; i += 1) {
      await attempt(app, 'wrong', '203.0.113.7');
    }
    expect((await attempt(app, 'wrong', '203.0.113.7')).status).toBe(429);
    expect((await attempt(app, 'wrong', '203.0.113.8')).status).toBe(401);
  });

  it('never throttles a successful login', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 9; i += 1) {
      await attempt(app, 'wrong', '203.0.113.9');
    }
    expect((await attempt(app, 'owner-password-123', '203.0.113.9')).status).toBe(200);
  });

  it('audits the resolved peer rather than a caller-supplied address', async () => {
    const { app, db } = makeApp();
    await attempt(app, 'wrong', '198.51.100.99, 203.0.113.7');
    const row = db
      .prepare("SELECT ip FROM admin_audit WHERE action = 'admin.login' ORDER BY id DESC")
      .get() as { ip: string };
    expect(row.ip).toBe('203.0.113.7');
  });
});

describe('PersistentLoginLimiter', () => {
  function makeDb() {
    const db = openDatabase(':memory:');
    migrateUp(db);
    return db;
  }

  it('shares the failure budget across limiter instances over the same DB', async () => {
    const db = makeDb();
    const first = new PersistentLoginLimiter(db, 3, 60_000);
    first.allow('10.0.0.1', 1_000);
    first.allow('10.0.0.1', 2_000);
    // A "restart": a fresh limiter opens the same DB and still sees the hits.
    const second = new PersistentLoginLimiter(db, 3, 60_000);
    expect(second.remaining('10.0.0.1', 3_000)).toBe(1);
    expect(second.allow('10.0.0.1', 3_000)).toBe(true);
    expect(second.allow('10.0.0.1', 4_000)).toBe(false);
  });

  it('slides the window and clears on success', async () => {
    const db = makeDb();
    const limiter = new PersistentLoginLimiter(db, 2, 60_000);
    limiter.allow('10.0.0.2', 1_000);
    limiter.allow('10.0.0.2', 10_000);
    // Both hits are inside the window, so the budget is exhausted.
    expect(limiter.allow('10.0.0.2', 50_000)).toBe(false);
    expect(limiter.remaining('10.0.0.2', 50_000)).toBe(0);
    // At 70_001 the earliest hit (t=1_000) has expired; one slot is free.
    expect(limiter.allow('10.0.0.2', 70_001)).toBe(true);
    // At 70_100 the second hit (t=10_000) expires too; only the fresh hit
    // from 70_001 remains, so one slot is free.
    expect(limiter.remaining('10.0.0.2', 70_100)).toBe(1);
    limiter.allow('10.0.0.2', 71_000);
    limiter.clear('10.0.0.2');
    expect(limiter.remaining('10.0.0.2', 72_000)).toBe(2);
  });
});

describe('dev-no-auth mode', () => {
  /** Fake node binding: getConnInfo reads c.env.incoming.socket.remoteAddress. */
  function peerEnv(remoteAddress: string) {
    return { incoming: { socket: { remoteAddress } } } as never;
  }

  it('grants a synthetic owner session to a loopback peer', async () => {
    const config = loadConfig({
      HUB_DEV_NO_AUTH: '1',
      HUB_MASTER_KEY: '',
      HUB_ADMIN_PASSWORD: '',
    });
    const db = openDatabase(':memory:');
    migrateUp(db);
    const app = createApp(config, db);

    const res = await app.request(
      '/api/admin/session',
      { headers: { Host: 'localhost:8791' } },
      peerEnv('127.0.0.1'),
    );
    expect(res.status).toBe(200);
  });

  it('denies a remote peer even when it spoofs a loopback Host header', async () => {
    const config = loadConfig({
      HUB_DEV_NO_AUTH: '1',
      HUB_MASTER_KEY: '',
      HUB_ADMIN_PASSWORD: '',
    });
    const db = openDatabase(':memory:');
    const app = createApp(config, db);

    const res = await app.request(
      '/api/admin/session',
      { headers: { Host: 'localhost:8791' } },
      peerEnv('203.0.113.9'),
    );
    expect(res.status).toBe(401);
  });

  it('refuses when the adapter exposes no socket to verify', async () => {
    const config = loadConfig({
      HUB_DEV_NO_AUTH: '1',
      HUB_MASTER_KEY: '',
      HUB_ADMIN_PASSWORD: '',
    });
    const db = openDatabase(':memory:');
    const app = createApp(config, db);

    const res = await app.request('/api/admin/session', {
      headers: { Host: 'localhost:8791' },
    });
    expect(res.status).toBe(401);
  });
});
