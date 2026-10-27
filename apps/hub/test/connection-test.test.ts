import { describe, it, expect } from 'vitest';
import {
  testProvider,
  type FetchLike,
  type ProviderTestInput,
} from '../src/connection-test.js';
import { SlidingWindowRateLimiter } from '../src/rate-limit.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchReturning(status: number, body: unknown): FetchLike {
  return () => Promise.resolve(jsonResponse(status, body));
}

const baseInput: ProviderTestInput = {
  base_url: 'https://example.com/v1',
  api_key: 'sk-test',
  protocol: 'openai-compatible',
  billing_type: 'payg',
  preset_id: 'ark',
};

describe('testProvider', () => {
  it('succeeds on a minimal chat with choices', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(200, {
        choices: [{ message: { content: 'ok' } }],
        model: 'doubao-seed-1-6-250615',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('provider');
    expect(result.model_echo).toBe('doubao-seed-1-6-250615');
  });

  it('uses max_tokens=32 for subscription and records echo', async () => {
    let captured: Record<string, unknown> = {};
    const spy: FetchLike = async (_url, init) => {
      captured = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse(200, { choices: [{}], model: 'auto' });
    };
    const result = await testProvider(
      { ...baseInput, billing_type: 'subscription', preset_id: 'ark-plan' },
      spy,
    );
    expect(result.ok).toBe(true);
    expect(captured.max_tokens).toBe(32);
    expect(result.model_echo).toBe('auto');
  });

  it('classifies 401 as unauthorized', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(401, { error: 'bad key' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('unauthorized');
  });

  it('classifies 403 as forbidden', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(403, { error: 'no access' }),
    );
    expect(result.error?.code).toBe('forbidden');
  });

  it('classifies 404 as model_not_found', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(404, { error: 'not found' }),
    );
    expect(result.error?.code).toBe('model_not_found');
  });

  it('classifies 429 as rate_limited', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(429, { error: 'slow down' }),
    );
    expect(result.error?.code).toBe('rate_limited');
  });

  it('classifies 500 as server_error', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(500, { error: 'boom' }),
    );
    expect(result.error?.code).toBe('server_error');
  });

  it('classifies a thrown fetch error as network', async () => {
    const fail: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await testProvider(baseInput, fail);
    expect(result.error?.code).toBe('network');
  });

  it('classifies 200 without choices as dialect_mismatch', async () => {
    const result = await testProvider(
      baseInput,
      fetchReturning(200, { data: [] }),
    );
    expect(result.error?.code).toBe('dialect_mismatch');
  });

  it('falls back to GET /models without a text model', async () => {
    let url = '';
    const spy: FetchLike = async (u) => {
      url = u;
      return jsonResponse(200, { data: [] });
    };
    const result = await testProvider(
      { ...baseInput, preset_id: null },
      spy,
    );
    expect(result.ok).toBe(true);
    expect(url).toContain('/models');
  });
});

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit then blocks', () => {
    const rl = new SlidingWindowRateLimiter(3, 1000);
    expect(rl.allow('k', 0)).toBe(true);
    expect(rl.allow('k', 100)).toBe(true);
    expect(rl.allow('k', 200)).toBe(true);
    expect(rl.allow('k', 300)).toBe(false);
    expect(rl.remaining('k', 300)).toBe(0);
  });

  it('slides the window to expire old hits', () => {
    const rl = new SlidingWindowRateLimiter(2, 1000);
    rl.allow('k', 0);
    rl.allow('k', 500);
    // At t=1000 the hit at 0 has expired; one slot is free.
    expect(rl.allow('k', 1000)).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = new SlidingWindowRateLimiter(1, 1000);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('b', 0)).toBe(true);
    expect(rl.allow('a', 100)).toBe(false);
  });
});
