import { describe, expect, it } from 'vitest';
import { isBackendPath } from '../src/backend-routes.js';

describe('isBackendPath', () => {
  it('routes admin API, public projection and probes to Hono', () => {
    expect(isBackendPath('/api/admin/providers')).toBe(true);
    expect(isBackendPath('/pub/v1/models')).toBe(true);
    expect(isBackendPath('/pub/v1/usage')).toBe(true);
    expect(isBackendPath('/healthz')).toBe(true);
    expect(isBackendPath('/readyz')).toBe(true);
  });

  it('renders console pages via Astro', () => {
    expect(isBackendPath('/providers')).toBe(false);
    expect(isBackendPath('/models')).toBe(false);
    expect(isBackendPath('/login')).toBe(false);
  });

  it('does not treat lookalike prefixes as backend paths', () => {
    expect(isBackendPath('/public/v1/models')).toBe(false);
    expect(isBackendPath('/apifoo')).toBe(false);
  });
});
