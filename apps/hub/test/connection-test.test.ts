import { describe, it, expect, vi } from 'vitest';
import {
  testProvider,
  testModel,
  type FetchLike,
  type ProviderTestInput,
  type ModelTestInput,
  type AsrProbeSocketFactory,
} from '../src/connection-test.js';
import { SlidingWindowRateLimiter } from '../src/rate-limit.js';
import type { ModelView } from '../src/repositories/models.js';

function makeModel(over: Partial<ModelView> = {}): ModelView {
  return {
    id: 'mdl_1',
    provider_id: 'prov_1',
    preset_model_id: null,
    model: 'test-model',
    display_name: 'Test',
    modalities: ['text'],
    litellm_id: null,
    context_window: 1000,
    supports_json: false,
    supports_stream: false,
    pricing: {},
    endpoints_override: null,
    adapter: null,
    is_default: false,
    sort_order: 0,
    enabled: true,
    reasoning: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function modelTestInput(
  model: ModelView,
  over: Partial<ModelTestInput> = {},
): ModelTestInput {
  return {
    base_url: 'https://example.com/v1',
    api_key: 'sk-test',
    billing_type: 'payg',
    model,
    deep: false,
    ...over,
  };
}

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

describe('testModel (L2)', () => {
  it('passes a text model with a matching echo at max_tokens=1', async () => {
    let captured: Record<string, unknown> = {};
    const spy: FetchLike = async (_url, init) => {
      captured = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse(200, { choices: [{}], model: 'test-model' });
    };
    const result = await testModel(modelTestInput(makeModel()), spy);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('model');
    expect(captured.max_tokens).toBe(1);
  });

  it('uses max_tokens=32 for a reasoning model', async () => {
    let captured: Record<string, unknown> = {};
    const spy: FetchLike = async (_url, init) => {
      captured = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse(200, { choices: [{}], model: 'test-model' });
    };
    const result = await testModel(
      modelTestInput(makeModel({ reasoning: true })),
      spy,
    );
    expect(result.ok).toBe(true);
    expect(captured.max_tokens).toBe(32);
  });

  it('does not compare echo for a subscription provider', async () => {
    const spy: FetchLike = () =>
      Promise.resolve(jsonResponse(200, { choices: [{}], model: 'auto' }));
    const result = await testModel(
      modelTestInput(makeModel(), { billing_type: 'subscription' }),
      spy,
    );
    expect(result.ok).toBe(true);
  });

  it('flags a mismatched echo as dialect_mismatch', async () => {
    const spy: FetchLike = () =>
      Promise.resolve(
        jsonResponse(200, { choices: [{}], model: 'some-other-model' }),
      );
    const result = await testModel(modelTestInput(makeModel()), spy);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('dialect_mismatch');
  });

  it('passes an embedding model', async () => {
    const model = makeModel({
      modalities: ['embedding'],
      model: 'embedding-model',
    });
    const spy: FetchLike = () =>
      Promise.resolve(jsonResponse(200, { data: [{}] }));
    const result = await testModel(modelTestInput(model), spy);
    expect(result.ok).toBe(true);
  });

  it('free-probes an image model via the models list', async () => {
    const model = makeModel({
      modalities: ['image'],
      model: 'image-model',
    });
    let url = '';
    const spy: FetchLike = async (u) => {
      url = u;
      return jsonResponse(200, { data: [] });
    };
    const result = await testModel(modelTestInput(model), spy);
    expect(result.ok).toBe(true);
    expect(url).toContain('/models');
  });

  it('deep image test performs one generation', async () => {
    const model = makeModel({
      modalities: ['image'],
      model: 'image-model',
      endpoints_override: { images: '/images/generations' },
    });
    const spy = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: [{}] })),
    );
    const result = await testModel(
      modelTestInput(model, { deep: true }),
      spy,
    );
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('deep video test submits once and never polls', async () => {
    const model = makeModel({
      modalities: ['video'],
      model: 'video-model',
      endpoints_override: { videos: '/videos' },
    });
    const spy = vi.fn(() =>
      Promise.resolve(new Response('', { status: 201 })),
    );
    const result = await testModel(
      modelTestInput(model, { deep: true }),
      spy,
    );
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('synthesizes audio via the x-api-key dialect (openspeech)', async () => {
    const model = makeModel({
      modalities: ['audio'],
      model: 'seed-tts-2.0',
      adapter: {
        auth_style: 'x-api-key',
        resource_id: 'seed-tts-2.0',
        submit_path: '/api/v3/plan/tts/unidirectional',
        create_body: {
          speaker: 'zh_female_vv_uranus_bigtts',
          audio_params: { format: 'mp3', sample_rate: 24000 },
        },
      },
    });
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    const spy: FetchLike = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = String(init?.body);
      return jsonResponse(200, {
        code: 0,
        data: Buffer.from('fake-mp3').toString('base64'),
      });
    };
    const result = await testModel(modelTestInput(model), spy);
    expect(result.ok).toBe(true);
    expect(capturedHeaders['X-Api-Key']).toBe('sk-test');
    expect(capturedHeaders['X-Api-Resource-Id']).toBe('seed-tts-2.0');
    expect(capturedHeaders.Authorization).toBeUndefined();
    const parsed = JSON.parse(capturedBody) as {
      req_params: { text: string; speaker: string };
    };
    expect(parsed.req_params.text).toBe('hi');
    expect(parsed.req_params.speaker).toBe('zh_female_vv_uranus_bigtts');
  });

  it('flags openspeech semantic errors as dialect_mismatch', async () => {
    const model = makeModel({
      modalities: ['audio'],
      model: 'seed-tts-2.0',
      adapter: {
        auth_style: 'x-api-key',
        resource_id: 'seed-tts-2.0',
        submit_path: '/api/v3/plan/tts/unidirectional',
      },
    });
    const spy: FetchLike = () =>
      Promise.resolve(
        jsonResponse(200, { code: 45000000, message: 'bad params' }),
      );
    const result = await testModel(modelTestInput(model), spy);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('dialect_mismatch');
  });

  it('uses the bearer dialect for openai-compatible TTS', async () => {
    const model = makeModel({
      modalities: ['audio'],
      model: 'gpt-4o-mini-tts',
      endpoints_override: { audio: '/audio/speech' },
    });
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    const spy: FetchLike = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = String(init?.body);
      return new Response('raw-audio-bytes', { status: 200 });
    };
    const result = await testModel(modelTestInput(model), spy);
    expect(result.ok).toBe(true);
    expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
    const parsed = JSON.parse(capturedBody) as {
      model: string;
      input: string;
    };
    expect(parsed.model).toBe('gpt-4o-mini-tts');
    expect(parsed.input).toBe('hi');
  });

  it('falls back to a TTS probe for a voice-only provider', async () => {
    let capturedHeaders: Record<string, string> = {};
    const spy: FetchLike = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(200, {
        code: 0,
        data: Buffer.from('fake-mp3').toString('base64'),
      });
    };
    const result = await testProvider(
      {
        base_url: 'https://openspeech.bytedance.com',
        api_key: 'sk-test',
        protocol: 'openai-compatible',
        billing_type: 'payg',
        preset_id: 'openspeech',
      },
      spy,
    );
    expect(result.ok).toBe(true);
    expect(capturedHeaders['X-Api-Key']).toBe('sk-test');
    expect(capturedHeaders['X-Api-Resource-Id']).toBe('seed-tts-2.0');
  });
});

describe('ASR WebSocket probe', () => {
  function asrModel(over: Partial<ModelView> = {}): ModelView {
    return makeModel({
      modalities: ['audio'],
      model: 'bigmodel',
      adapter: {
        auth_style: 'x-api-key',
        resource_id: 'volc.seedasr.sauc.duration',
        submit_path: '/api/v3/plan/sauc/bigmodel_async',
      },
      ...over,
    });
  }

  function fakeFactory(opts: {
    onOpen?: boolean;
    upgradeStatus?: number;
    error?: boolean;
  }): AsrProbeSocketFactory {
    return (_url, _headers) => {
      const handlers: {
        open?: () => void;
        error?: (err: Error) => void;
        upgrade?: (res: { status: number }) => void;
      } = {};
      const socket = {
        onOpen: (cb: () => void) => {
          handlers.open = cb;
        },
        onError: (cb: (err: Error) => void) => {
          handlers.error = cb;
        },
        onUnexpectedResponse: (cb: (res: { status: number }) => void) => {
          handlers.upgrade = cb;
        },
        close: () => {},
      };
      // Fire synchronously to keep the test deterministic.
      if (opts.onOpen) queueMicrotask(() => handlers.open?.());
      if (opts.upgradeStatus !== undefined)
        queueMicrotask(() => handlers.upgrade?.({ status: opts.upgradeStatus! }));
      if (opts.error) queueMicrotask(() => handlers.error?.(new Error('boom')));
      return socket;
    };
  }

  it('uses a fake socket factory to validate handshake success', async () => {
    // Drive probeAsrWs indirectly: build a model whose submit_path is sauc,
    // then run testModel with a factory injected through the module's export
    // is not possible, so we exercise the happy path by checking the header
    // contract via a captured factory below.
    const captured: { url: string; headers: Record<string, string> }[] = [];
    const factory: AsrProbeSocketFactory = (_url, headers) => {
      captured.push({ url: _url, headers });
      const handlers: Record<string, (arg?: unknown) => void> = {};
      queueMicrotask(() => handlers.open?.());
      return {
        onOpen: (cb) => {
          handlers.open = cb;
        },
        onError: () => {},
        onUnexpectedResponse: () => {},
        close: () => {},
      };
    };
    // Direct import of probeAsrWs through the same module.
    const { probeAsrWs } = await import('../src/connection-test.js');
    const result = await probeAsrWs(
      'https://openspeech.bytedance.com',
      'sk-test',
      asrModel(),
      5_000,
      factory,
    );
    expect(result.ok).toBe(true);
    expect(captured[0]?.url).toBe(
      'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async',
    );
    expect(captured[0]?.headers['X-Api-Key']).toBe('sk-test');
    expect(captured[0]?.headers['X-Api-Resource-Id']).toBe(
      'volc.seedasr.sauc.duration',
    );
  });

  it('classifies a 401 WebSocket upgrade as unauthorized', async () => {
    const { probeAsrWs } = await import('../src/connection-test.js');
    const result = await probeAsrWs(
      'https://openspeech.bytedance.com',
      'sk-test',
      asrModel(),
      5_000,
      fakeFactory({ upgradeStatus: 401 }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('unauthorized');
  });

  it('classifies a failed connection as network', async () => {
    const { probeAsrWs } = await import('../src/connection-test.js');
    const result = await probeAsrWs(
      'https://openspeech.bytedance.com',
      'sk-test',
      asrModel(),
      5_000,
      fakeFactory({ error: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('network');
  });
});
