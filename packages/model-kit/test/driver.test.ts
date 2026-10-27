import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeJson,
  streamChat,
  createFakeFetch,
  FakeProviderError,
  initModelKit,
} from '../src/index.js';
import { postUsage } from '../src/reporter.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CatalogResponse, ResolvedModel } from '../src/index.js';

const fixturePath = fileURLToPath(
  new URL(
    '../../../contracts/fixtures/models-response.example.json',
    import.meta.url,
  ),
);
const catalog = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as CatalogResponse;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-kit-driver-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function firstTextModel(): ResolvedModel {
  const m = catalog.models[0];
  if (!m) throw new Error('no fixture model');
  return {
    assignmentId: m.assignment_id,
    alias: m.alias,
    role: m.role,
    modalities: m.modalities,
    model: m.model,
    litellmId: m.litellm_id,
    displayName: m.display_name,
    protocol: m.protocol,
    baseUrl: m.base_url,
    apiKey: m.api_key,
    endpoints: m.endpoints,
    adapter: m.adapter,
    contextWindow: m.context_window,
    supportsJson: m.supports_json,
    supportsStream: m.supports_stream,
    dailyBudgetMicros: m.daily_budget_micros,
    pricing: m.pricing,
    source: 'hub',
  };
}

describe('openai-compatible driver', () => {
  it('completes a non-streaming chat', async () => {
    const fake = createFakeFetch({ responseText: 'hello' });
    const result = await completeJson(
      { model: firstTextModel(), messages: [{ role: 'user', content: 'hi' }] },
      fake,
    );
    expect(result.content).toBe('hello');
    expect(result.usage?.total_tokens).toBe(2);
    expect(result.httpStatus).toBe(200);
  });

  it('streams deltas and final usage', async () => {
    const fake = createFakeFetch({ responseText: 'streamed' });
    const chunks: string[] = [];
    let finalUsage;
    for await (const chunk of streamChat(
      { model: firstTextModel(), messages: [{ role: 'user', content: 'hi' }] },
      fake,
    )) {
      if (chunk.delta) chunks.push(chunk.delta);
      if (chunk.usage) finalUsage = chunk.usage;
    }
    expect(chunks.join('')).toBe('streamed');
    expect(finalUsage?.total_tokens).toBe(2);
  });

  it('passes an abort signal through', async () => {
    const controller = new AbortController();
    const fake = createFakeFetch();
    const promise = completeJson(
      {
        model: firstTextModel(),
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      },
      fake,
    );
    // The fake resolves immediately; just verify the signal is accepted.
    controller.abort();
    const result = await promise;
    expect(result.httpStatus).toBe(200);
  });
});

describe('usage reporting', () => {
  it('posts usage to the hub', async () => {
    const calls: string[] = [];
    const mock = (async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as typeof fetch;
    await postUsage('https://hub.local', 'tok', mock, {
      project: 'zeus',
      feature: 'noul',
      billingSource: 'builtin',
      model: firstTextModel(),
      inputTokens: 10,
      outputTokens: 5,
      httpStatus: 200,
    });
    expect(calls[0]).toContain('/pub/v1/usage');
  });

  it('reports usage in the background after a chat', async () => {
    const usageCalls: string[] = [];
    const mock = (async (input) => {
      const url = String(input);
      if (url.includes('/pub/v1/models')) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      if (url.includes('/pub/v1/usage')) {
        usageCalls.push(url);
        return new Response(JSON.stringify({ accepted: true }), {
          status: 200,
        });
      }
      // provider chat
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: mock,
    });
    const result = await kit.chat('noul', [
      { role: 'user', content: 'hi' },
    ]);
    expect(result.content).toBe('ok');
    // Allow the background report to flush.
    await vi.waitFor(() => expect(usageCalls.length).toBe(1));
    kit.stop();
  });
});

describe('fake provider', () => {
  it('refuses to start in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createFakeFetch()).toThrow(FakeProviderError);
  });
});
