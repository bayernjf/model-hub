import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { authenticate } from '../../auth/accounts.js';
import { requireAdmin, type AppEnv } from '../../auth/middleware.js';
import { clientIp, isHttps } from '../../auth/request.js';
import {
  clearSessionCookie,
  createSessionToken,
  setSessionCookie,
} from '../../auth/session.js';
import { writeAudit } from '../../audit.js';
import type { HubConfig } from '../../config.js';
import { PersistentLoginLimiter } from '../../login-limiter.js';

interface LoginBody {
  username?: string;
  password?: string;
}

export function sessionRoutes(
  config: HubConfig,
  db: DatabaseSync,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  // Login brute-force guard: at most 10 failed attempts per 15 minutes per IP.
  // Only failures consume the budget, so a successful login is never throttled.
  // Persisted in login_attempts so the budget survives restarts and is shared
  // across instances opening the same DB file.
  const loginLimiter = new PersistentLoginLimiter(db, 10, 15 * 60_000);

  // Login is public; it is registered before the auth middleware.
  routes.post('/session', async (c) => {
    const body = (await c.req.json().catch(() => null)) as LoginBody | null;
    const username = body?.username ?? '';
    const password = body?.password ?? '';
    const ip = clientIp(c);

    if (loginLimiter.remaining(ip) <= 0) {
      writeAudit(db, {
        actor: username || 'unknown',
        action: 'admin.login',
        targetType: 'session',
        result: 'denied',
        detail: 'rate_limited',
        ip,
      });
      return c.json(
        {
          error: {
            code: 'rate_limited',
            hint: '登录尝试过于频繁，请 15 分钟后再试',
          },
        },
        429,
      );
    }

    const identity = authenticate(config, username, password);
    if (!identity) {
      loginLimiter.allow(ip); // consume one failed attempt
      writeAudit(db, {
        actor: username || 'unknown',
        action: 'admin.login',
        targetType: 'session',
        result: 'failure',
        ip,
      });
      return c.json({ error: { code: 'invalid_credentials' } }, 401);
    }

    const token = createSessionToken(identity, config.sessionKey);
    loginLimiter.clear(ip); // a correct login lifts any earlier lockout
    writeAudit(db, {
      actor: identity.username,
      action: 'admin.login',
      targetType: 'session',
      result: 'success',
      ip,
    });

    c.header('Set-Cookie', setSessionCookie(token, isHttps(c)));
    return c.json({
      user: { username: identity.username, role: identity.role },
    });
  });

  // Everything below requires an authenticated session.
  routes.use('*', requireAdmin(config));

  routes.get('/session', (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: { code: 'unauthorized' } }, 401);
    return c.json({
      user: { username: session.username, role: session.role },
    });
  });

  routes.delete('/session', (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: { code: 'unauthorized' } }, 401);
    c.header('Set-Cookie', clearSessionCookie(isHttps(c)));
    writeAudit(db, {
      actor: session.username,
      action: 'admin.logout',
      targetType: 'session',
      result: 'success',
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  return routes;
}
