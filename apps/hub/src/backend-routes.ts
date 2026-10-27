/**
 * Request paths served by the Hono backend in the single-process server.
 * Everything else is rendered by the Astro SSR console.
 */
export function isBackendPath(url: string): boolean {
  return (
    url.startsWith('/api/') ||
    url.startsWith('/pub/') ||
    url === '/healthz' ||
    url === '/readyz'
  );
}
