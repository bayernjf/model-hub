import type { Context, MiddlewareHandler, Next } from 'hono';
import type { HubConfig } from '../config.js';
import { isLoopbackPeer } from './request.js';
import {
  parseSessionCookie,
  verifySessionToken,
  type SessionPayload,
} from './session.js';

export type AppEnv = {
  Variables: {
    session: SessionPayload | null;
  };
};

function unauthorized(c: Context): Response {
  return c.json(
    {
      error: { code: 'unauthorized', message: 'authentication required' },
    },
    401,
  );
}

function redirectToLogin(c: Context): Response {
  const url = new URL(c.req.url);
  const target = encodeURIComponent(url.pathname + url.search);
  return c.redirect(`/login?next=${target}`);
}

// Require an authenticated admin session. In dev mode a synthetic owner
// session is granted, but only to loopback hosts. API requests missing a
// session get 401; page requests get redirected to the login page.
export function requireAdmin(config: HubConfig): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    if (config.devNoAuth) {
      if (!isLoopbackPeer(c)) return unauthorized(c);
      c.set('session', {
        username: 'dev',
        role: 'owner',
        exp: Number.MAX_SAFE_INTEGER,
      });
      return next();
    }

    const raw = parseSessionCookie(c.req.header('Cookie') ?? null);
    const session = raw ? verifySessionToken(raw, config.sessionKey) : null;
    c.set('session', session);

    if (!session) {
      const pathname = new URL(c.req.url).pathname;
      if (pathname.startsWith('/api/')) return unauthorized(c);
      return redirectToLogin(c);
    }

    return next();
  };
}

// Restrict to owner. Must run after requireAdmin (which sets the session).
// Operator is read-only and receives 403 on write endpoints.
export function requireOwner(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    const session = c.get('session');
    if (!session) return unauthorized(c);
    if (session.role !== 'owner') {
      return c.json(
        { error: { code: 'forbidden', message: 'owner role required' } },
        403,
      );
    }
    return next();
  };
}
