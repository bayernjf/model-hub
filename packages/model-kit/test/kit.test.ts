import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initModelKit,
  ResolutionError,
} from '../src/index.js';
import { writeCache } from '../src/cache.js';
import type {
  CatalogResponse,
  ResolvedModel,
  TestResult,
} from '../src/types.js';

const fixturePath = fileURLToPath(
  new URL(
    '../../../contracts/fixtures/models-response.example.json',
    import.meta.url,
  ),
);
const catalog = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as CatalogResponse;

function fetchWith(
  behavior: {
    body?: CatalogResponse | null;
    status?: number;
    throwError?: boolean;
    honorEtag?: boolean;
  },
  calls: Array<{ url: string; headers: Record<string, string> }> = [],
): typeof fetch {
  return (async (input, init) => {
    const headers =
      (init?.headers as Record<string, string> | undefined) ?? {};
    calls.push({ url: String(input), headers });

    if (behavior.throwError) throw new Error('network down');
    if (behavior.honorEtag && headers['If-None-Match']) {
      return new Response(null, { status: 304 });
    }
    const status = behavior.status ?? 200;
    return new Response(
      behavior.body ? JSON.stringify(behavior.body) : null,
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-kit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cachePath = () => join(dir, 'cache.json');

describe('catalog pull and cache', () => {
  it('pulls the catalog and lists models', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ body: catalog }),
    });
    expect(kit.list()).toHaveLength(3);
    expect(kit.list('text')).toHaveLength(2);
    kit.stop();
  });

  it('persists the cache with the pulled catalog', async () => {
    const path = cachePath();
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: path,
      fetch: fetchWith({ body: catalog }),
    });
    kit.stop();
    const kit2 = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: path,
      fetch: fetchWith({ body: null, honorEtag: true }),
    });
    expect(kit2.list()).toHaveLength(3);
    kit2.stop();
  });

  it('falls back to cache when the hub is unreachable', async () => {
    const path = cachePath();
    writeCache(path, catalog);
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: path,
      fetch: fetchWith({ throwError: true }),
    });
    expect(kit.list()).toHaveLength(3);
    expect(kit.revision).toBe(42);
    kit.stop();
  });
});

describe('resolution order', () => {
  it('resolves by alias', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ body: catalog }),
    });
    const noul = kit.resolve('noul');
    expect(noul.model).toBe('ark-code-latest');
    expect(noul.source).toBe('hub');
    expect(noul.baseUrl).toBe(catalog.models[0]?.base_url);
    kit.stop();
  });

  it('fails closed when no source provides the alias', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ throwError: true }),
    });
    expect(() => kit.resolve('noul')).toThrow(ResolutionError);
    kit.stop();
  });

  it('uses env fallback after the hub misses', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ throwError: true }),
      envFallback: {
        noul: {
          baseUrl: 'https://env.example/v1',
          apiKey: 'env-key',
          model: 'env-model',
        },
      },
    });
    const resolved = kit.resolve('noul');
    expect(resolved.source).toBe('env');
    expect(resolved.apiKey).toBe('env-key');
    kit.stop();
  });

  it('prefers BYOK over hub and env', async () => {
    const byok: ResolvedModel = {
      assignmentId: '',
      alias: 'noul',
      role: 'primary',
      modalities: ['text'],
      model: 'user-model',
      litellmId: null,
      displayName: null,
      protocol: 'openai-compatible',
      baseUrl: 'https://byok.example/v1',
      apiKey: 'user-key',
      endpoints: {},
      adapter: null,
      contextWindow: null,
      supportsJson: false,
      supportsStream: false,
      dailyBudgetMicros: null,
      pricing: null,
      source: 'byok',
    };
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ body: catalog }),
      resolveByok: () => byok,
    });
    expect(kit.resolve('noul').source).toBe('byok');
    kit.stop();
  });

  it('returns the primary model for a modality', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ body: catalog }),
    });
    expect(kit.primary('image').model).toBe('doubao-seedream-4-0-250828');
    kit.stop();
  });
});

describe('L3 and L4 tests', () => {
  it('pings the hub successfully', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ body: catalog }),
    });
    const ping = await kit.pingHub();
    expect(ping.ok).toBe(true);
    expect(ping.revision).toBe(42);
    kit.stop();
  });

  it('runs the default probe for L4', async () => {
    // The probe POSTs to the provider chat endpoint.
    const mock = (async (input) => {
      if (String(input).includes('/pub/v1/models')) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{}], model: 'ark-code-latest' }),
        { status: 200 },
      );
    }) as typeof fetch;
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: mock,
    });
    const result = await kit.testConnection('noul');
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('L4');
    kit.stop();
  });

  it('uses an injected driver factory', async () => {
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: fetchWith({ body: catalog }),
    });
    const injected: TestResult = {
      ok: true,
      latency_ms: 7,
      scope: 'L4',
    };
    const result = await kit.testConnection('noul', {
      driverFactory: () => ({ probe: async () => injected }),
    });
    expect(result.latency_ms).toBe(7);
    kit.stop();
  });
});

describe('embedding usage reporting', () => {
  // The hub must be able to price embedding calls, so ModelKit.embed has to
  // forward the provider-echoed prompt_tokens in its usage report (fake hub
  // captures the POST body; no real provider or hub is contacted).
  it('reports the echoed input tokens after an embed call', async () => {
    const usageBodies: unknown[] = [];
    const embedCatalog: CatalogResponse = {
      project: 'kit-test',
      revision: 3,
      fetched_at: '2026-01-01T00:00:00Z',
      models: [
        {
          assignment_id: 'asn_emb1',
          alias: 'embed',
          role: 'primary',
          modalities: ['embedding'],
          model: 'doubao-embedding-vision',
          litellm_id: null,
          display_name: null,
          protocol: 'openai-compatible',
          base_url: 'https://provider.example/v1',
          api_key: 'vendor-key',
          endpoints: { embeddings: '/embeddings' },
          adapter: null,
          context_window: null,
          supports_json: false,
          supports_stream: false,
          daily_budget_micros: null,
          pricing: null,
        },
      ],
    };
    const mock = (async (input, init) => {
      const url = String(input);
      if (url.includes('/pub/v1/models')) {
        return new Response(JSON.stringify(embedCatalog), { status: 200 });
      }
      if (url.endsWith('/embeddings')) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.5, 0.5] }, { embedding: [0.25, 0.75] }],
            usage: { prompt_tokens: 57, total_tokens: 57 },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/pub/v1/usage')) {
        usageBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ accepted: true }), {
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: cachePath(),
      fetch: mock,
    });
    const result = await kit.embed('embed', ['a', 'b']);
    expect(result.vectors).toEqual([[0.5, 0.5], [0.25, 0.75]]);
    // Allow the fire-and-forget usage report to flush before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(usageBodies).toHaveLength(1);
    const usage = usageBodies[0] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(57);
    expect(usage['model']).toBe('doubao-embedding-vision');
    expect(usage['assignment_id']).toBe('asn_emb1');
    kit.stop();
  });
});
