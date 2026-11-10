import type { HubConfig } from './config.js';
import { parseSessionCookie, verifySessionToken } from './auth/session.js';

/**
 * Pages the Astro console serves without a session. The login form must be
 * reachable, and its bundle comes from /_astro — closing that prefix would
 * render the login page as a blank shell that cannot authenticate anyone.
 */
const PUBLIC_PAGES = new Set(['/login']);
const PUBLIC_PREFIXES = ['/_astro/', '/favicon'];

export function isPublicPagePath(pathname: string): boolean {
  if (PUBLIC_PAGES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * True when the request carries a valid admin session cookie.
 *
 * Page requests never reach the Hono `requireAdmin` middleware: the Node entry
 * sends every non-backend path straight to Astro. That middleware therefore
 * documented a redirect-to-login branch for pages that no page request could
 * ever trigger, and the console shell answered 200 to anonymous callers. The
 * check has to run at the entry, before Astro sees the request.
 */
export function hasAdminSession(
  cookieHeader: string | null,
  config: Pick<HubConfig, 'devNoAuth' | 'sessionKey'>,
  now: number = Date.now(),
): boolean {
  // Loopback-only development mode: loadConfig rejects it under
  // NODE_ENV=production and rejects it when either secret is set.
  if (config.devNoAuth) return true;
  const token = parseSessionCookie(cookieHeader);
  return token !== null && verifySessionToken(token, config.sessionKey, now) !== null;
}
