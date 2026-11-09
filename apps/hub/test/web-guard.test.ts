import { describe, it, expect } from 'vitest';
import { hasAdminSession, isPublicPagePath } from '../src/web-guard.js';
import { createSessionToken, SESSION_COOKIE } from '../src/auth/session.js';

const NOW = 1_760_000_000_000;
const KEY = 'test-session-key-0123456789';
const cfg = { devNoAuth: false, sessionKey: KEY };

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

describe('isPublicPagePath', () => {
  it('opens the login form and the assets it needs', () => {
    expect(isPublicPagePath('/login')).toBe(true);
    expect(isPublicPagePath('/_astro/entry.abc123.js')).toBe(true);
    expect(isPublicPagePath('/favicon.svg')).toBe(true);
  });

  it('does not open the console pages', () => {
    expect(isPublicPagePath('/')).toBe(false);
    expect(isPublicPagePath('/billing')).toBe(false);
    expect(isPublicPagePath('/costs')).toBe(false);
    expect(isPublicPagePath('/projects')).toBe(false);
    // A path that merely starts with /login must not slip through.
    expect(isPublicPagePath('/login-as-admin')).toBe(false);
  });
});

describe('hasAdminSession', () => {
  it('rejects a request with no cookie', () => {
    expect(hasAdminSession(null, cfg, NOW)).toBe(false);
    expect(hasAdminSession('', cfg, NOW)).toBe(false);
  });

  it('accepts a token this server signed', () => {
    const token = createSessionToken({ username: 'owner', role: 'owner' }, KEY, NOW);
    expect(hasAdminSession(cookieFor(token), cfg, NOW)).toBe(true);
  });

  it('rejects a token signed with another key', () => {
    const token = createSessionToken(
      { username: 'owner', role: 'owner' },
      'some-other-key-0123456789',
      NOW,
    );
    expect(hasAdminSession(cookieFor(token), cfg, NOW)).toBe(false);
  });

  it('rejects a token whose payload was altered', () => {
    const token = createSessionToken({ username: 'owner', role: 'owner' }, KEY, NOW);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ username: 'intruder', role: 'owner', exp: NOW + 1 }),
    ).toString('base64url');
    expect(hasAdminSession(cookieFor(`${forged}.${sig}`), cfg, NOW)).toBe(false);
    expect(payload).not.toBe(forged);
  });

  it('rejects an expired token', () => {
    const token = createSessionToken({ username: 'owner', role: 'owner' }, KEY, NOW - 13 * 3600 * 1000);
    expect(hasAdminSession(cookieFor(token), cfg, NOW)).toBe(false);
  });

  it('ignores an unrelated cookie', () => {
    const token = createSessionToken({ username: 'owner', role: 'owner' }, KEY, NOW);
    expect(hasAdminSession(`other=1; hub_session_old=${token}`, cfg, NOW)).toBe(false);
  });

  it('bypasses the cookie only in loopback dev mode', () => {
    expect(hasAdminSession(null, { ...cfg, devNoAuth: true }, NOW)).toBe(true);
  });
});
