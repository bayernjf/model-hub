import type { Context } from 'hono';

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

// Whether the request targets a loopback host. HUB_DEV_NO_AUTH is permitted
// only when the Host header is a loopback name.
export function isLoopbackHost(c: Context): boolean {
  const host = (c.req.header('host') ?? '').toLowerCase();
  const name = host.split(':')[0] ?? '';
  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '::1' ||
    name === '[::1]'
  );
}
