import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

// Best-effort client IP for audit records and the login throttle. The service
// is loopback-only in development and sits behind a single Caddy hop in
// production, and Caddy APPENDS the peer it saw to any client-supplied
// X-Forwarded-For. So the RIGHT-most entry is the one our own proxy added.
//
// Reading the left-most entry instead (the pre-W7 behaviour) lets a caller
// choose its own bucket by sending a fresh header per request: that defeats
// the login brute-force limiter and poisons every audit row with a
// caller-chosen address.
//
// Flip condition: a second trusted proxy in front means the right-most entry
// is that proxy, and every client would share one bucket. Pin the hop count in
// config before adding one.
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');
    const peer = hops[hops.length - 1];
    if (peer !== undefined) return peer;
  }
  return '127.0.0.1';
}

export function isHttps(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto');
  if (forwardedProto) return forwardedProto.split(',')[0]?.trim() === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

// Whether the request arrived over a loopback socket. HUB_DEV_NO_AUTH is a
// developer convenience, so it must not be grantable over the network: the
// Host header is caller-controlled and says nothing about who actually
// connected, so a remote caller could pass it by sending `Host: 127.0.0.1`.
//
// Fail closed: when the adapter exposes no socket (unit tests using
// app.request without env, or another runtime), there is nothing to verify and
// the synthetic session is refused.
export function isLoopbackPeer(c: Context): boolean {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}
