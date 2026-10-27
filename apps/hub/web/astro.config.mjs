import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

// SSR admin console. In production a single Node server routes /api/* to
// the Hono app and everything else to the Astro handler built here.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  server: { host: '127.0.0.1', port: 8792 },
  trailingSlash: 'ignore',
});
