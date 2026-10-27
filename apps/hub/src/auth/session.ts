import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdminRole } from '../config.js';

export const SESSION_COOKIE = 'hub_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export interface SessionPayload {
  username: string;
  role: AdminRole;
  exp: number;
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

// Stateless, HMAC-signed session token: <base64url payload>.<base64url hmac>.
export function createSessionToken(
  identity: { username: string; role: AdminRole },
  secret: string,
  now: number = Date.now(),
): string {
  const payload: SessionPayload = {
    username: identity.username,
    role: identity.role,
    exp: now + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): SessionPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, secret);

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as SessionPayload;
    if (
      typeof payload.username !== 'string' ||
      (payload.role !== 'owner' && payload.role !== 'operator') ||
      typeof payload.exp !== 'number' ||
      payload.exp < now
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      return trimmed.slice(SESSION_COOKIE.length + 1);
    }
  }
  return null;
}

export function setSessionCookie(token: string, secure: boolean): string {
  const secureFlag = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}${secureFlag}`;
}

export function clearSessionCookie(secure: boolean): string {
  const secureFlag = secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag}`;
}
