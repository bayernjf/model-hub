import { describe, expect, it, vi } from 'vitest';
import { completeJson, streamChat } from '../src/driver.js';
import { AllProviderKeysExhaustedError, ProviderRequestError } from '../src/provider-errors.js';
import type { ResolvedModel } from '../src/types.js';

const base: ResolvedModel = {
  assignmentId: 'asg_1',
  alias: 'text',
  role: 'primary',
  modalities: ['text'],
  model: 'ark-code-latest',
  litellmId: null,
  displayName: null,
  protocol: 'openai-compatible',
  baseUrl: 'https://provider.test/api/v3',
  apiKey: 'legacy-key',
  endpoints: { chat: '/chat/completions' },
  adapter: null,
  contextWindow: null,
  supportsJson: true,
  supportsStream: true,
  dailyBudgetMicros: null,
  pricing: null,
  source: 'hub',
};

function withKeys(...keys: Array<{ key: string; keyId: string }>): ResolvedModel {
  return { ...base, apiKeys: keys.map((k) => ({ ...k, label: '' })) };
}

const quota429 = { error: { code: 'QuotaExceeded', message: 'subscription quota exceeded' } };
const rate429 = { error: { code: 'TooManyRequests', message: 'rpm rate limit' } };
const okBody = {
  id: 'c1',
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

interface Call {
  status: number;
  body?: unknown;
  // For stream responses: emit SSE frames after the header. When false this is
  // a header-stage failure (body consumed as JSON error).
  sse?: string[];
}

// Scripted fetch: pops one response per call and records which key was used.
function scriptedFetch(calls: Call[]) {
  const used: string[] = [];
  const bodies: string[] = [];
  let i = 0;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    used.push(auth.replace('Bearer ', ''));
    bodies.push(String(init?.body ?? ''));
    const call = calls[i] ?? { status: 500, body: { error: { code: 'unexpected' } } };
    i += 1;
    if (call.sse) {
      const sse = call.sse.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }), { status: call.status, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(call.body ?? {}), {
      status: call.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, used, bodies, calls: () => i };
}

import type { ChatCall } from '../src/driver.js';
type ExhaustedSpy = NonNullable<ChatCall['onKeyExhausted']>;

describe('completeJson key failover', () => {
  const chatCall = (model: ResolvedModel, fetchImpl: typeof fetch, onKeyExhausted?: ExhaustedSpy) =>
    completeJson({ model, messages: [{ role: 'user', content: 'hi' }], onKeyExhausted }, fetchImpl);

  it('replays the identical request with the next key on a quota 429', async () => {
    const s = scriptedFetch([
      { status: 429, body: quota429 },
      { status: 200, body: okBody },
    ]);
    const onExhausted = vi.fn();
    const r = await chatCall(withKeys({ key: 'key-a', keyId: 'pkey_a' }, { key: 'key-b', keyId: 'pkey_b' }), s.fetchImpl, onExhausted);
    expect(r.httpStatus).toBe(200);
    expect(r.content).toBe('ok');
    expect(r.keyFailover).toBe(true);
    expect(r.keyId).toBe('pkey_b');
    expect(s.used).toEqual(['key-a', 'key-b']);
    // Same request body on both attempts (replay, not a new prompt).
    expect(s.bodies[0]).toBe(s.bodies[1]);
    expect(onExhausted).toHaveBeenCalledWith(expect.objectContaining({ keyId: 'pkey_a', status: 429, code: 'QuotaExceeded' }));
  });

  it('does not rotate on ordinary rate limiting', async () => {
    const s = scriptedFetch([{ status: 429, body: rate429 }]);
    const onExhausted = vi.fn();
    const r = await chatCall(withKeys({ key: 'key-a', keyId: 'pkey_a' }, { key: 'key-b', keyId: 'pkey_b' }), s.fetchImpl, onExhausted);
    expect(r.httpStatus).toBe(429);
    expect(r.keyFailover).toBeUndefined();
    expect(s.used).toEqual(['key-a']); // never touched key-b
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('does not rotate on 401 or 5xx', async () => {
    for (const body of [
      { status: 401, body: { error: { code: 'AuthenticationError', message: "The API key doesn't exist." } } },
      { status: 500, body: { error: { code: 'InternalError' } } },
    ]) {
      const s = scriptedFetch([body]);
      const r = await chatCall(withKeys({ key: 'a', keyId: 'ka' }, { key: 'b', keyId: 'kb' }), s.fetchImpl);
      expect(r.httpStatus).toBe(body.status);
      expect(s.used).toHaveLength(1);
    }
  });

  it('throws AllProviderKeysExhaustedError when every key is quota-spent', async () => {
    const s = scriptedFetch([
      { status: 429, body: quota429 },
      { status: 429, body: quota429 },
    ]);
    const onExhausted = vi.fn();
    await expect(
      chatCall(withKeys({ key: 'a', keyId: 'ka' }, { key: 'b', keyId: 'kb' }), s.fetchImpl, onExhausted),
    ).rejects.toBeInstanceOf(AllProviderKeysExhaustedError);
    expect(s.used).toEqual(['a', 'b']);
    expect(onExhausted).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy single-key behavior byte-identical (no pool field)', async () => {
    const s = scriptedFetch([{ status: 200, body: okBody }]);
    const r = await chatCall(base, s.fetchImpl);
    expect(r.httpStatus).toBe(200);
    expect(r.content).toBe('ok');
    expect(r.keyId).toBe('');
    expect(r.keyFailover).toBeUndefined();
    expect(s.used).toEqual(['legacy-key']);

    // A quota 429 on the legacy single key surfaces rather than rotating.
    const s2 = scriptedFetch([{ status: 429, body: quota429 }]);
    const r2 = await chatCall(base, s2.fetchImpl);
    expect(r2.httpStatus).toBe(429);
    expect(r2.keyFailover).toBeUndefined();
  });
});

describe('streamChat key failover (header stage only)', () => {
  const okFrame = (text: string) => ({ choices: [{ delta: { content: text } }] });
  const usageFrame = { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

  it('fails over when a 429 arrives before any content', async () => {
    const s = scriptedFetch([
      { status: 429, body: quota429 },
      { status: 200, sse: [JSON.stringify(okFrame('hi')), JSON.stringify(usageFrame)] },
    ]);
    const onExhausted = vi.fn();
    const chunks = [];
    for await (const c of streamChat({ model: withKeys({ key: 'a', keyId: 'ka' }, { key: 'b', keyId: 'kb' }), messages: [{ role: 'user', content: 'hi' }], onKeyExhausted: onExhausted }, s.fetchImpl)) {
      chunks.push(c);
    }
    expect(s.used).toEqual(['a', 'b']);
    expect(chunks.some((c) => c.keyFailover)).toBe(true);
    expect(chunks.filter((c) => c.delta).map((c) => c.delta).join('')).toBe('hi');
    expect(onExhausted).toHaveBeenCalledWith(expect.objectContaining({ keyId: 'ka' }));
  });

  it('does not fail over on an ordinary 429 even at the header stage', async () => {
    const s = scriptedFetch([{ status: 429, body: rate429 }]);
    await expect(async () => {
      for await (const _ of streamChat({ model: withKeys({ key: 'a', keyId: 'ka' }, { key: 'b', keyId: 'kb' }), messages: [] }, s.fetchImpl)) {
        // drain
      }
    }).rejects.toBeInstanceOf(ProviderRequestError);
    expect(s.used).toEqual(['a']);
  });

  it('throws when all keys are quota-spent before streaming starts', async () => {
    const s = scriptedFetch([
      { status: 429, body: quota429 },
      { status: 429, body: quota429 },
    ]);
    await expect(async () => {
      for await (const _ of streamChat({ model: withKeys({ key: 'a', keyId: 'ka' }, { key: 'b', keyId: 'kb' }), messages: [] }, s.fetchImpl)) {
        // drain
      }
    }).rejects.toBeInstanceOf(AllProviderKeysExhaustedError);
    expect(s.used).toEqual(['a', 'b']);
  });
});
