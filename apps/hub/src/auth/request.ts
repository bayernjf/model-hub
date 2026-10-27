import type { Context } from 'hono';

// Best-effort client IP for audit records. The service is loopback-only in
// development and behind Caddy in production, so the forwarded header is set
// by the trusted proxy.
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
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
