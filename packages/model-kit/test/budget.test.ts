import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initModelKit,
  BudgetExceededError,
  budgetStateFor,
  type CatalogResponse,
  type ProjectedModel,
  type ResolvedModel,
  type UsageSummary,
} from '../src/index.js';

// W5-1/W5-2 cost governance on the project side: budget readout, reroute to
// a same-modality fallback when the primary is over budget, fail-closed
// BudgetExceededError without one, and the env/option kill switch.

function model(overrides: Partial<ProjectedModel>): ProjectedModel {
  return {
    assignment_id: 'asn_x',
    alias: null,
    role: 'primary',
    modalities: ['text'],
    model: 'm',
    litellm_id: null,
    display_name: null,
    protocol: 'openai-compatible',
    base_url: 'https://p.local/v1',
    api_key: 'k',
    endpoints: { chat: '/chat/completions' },
    adapter: null,
    context_window: null,
    supports_json: true,
    supports_stream: true,
    daily_budget_micros: null,
    pricing: null,
    ...overrides,
  };
}

function catalogWith(
  primary: Partial<ProjectedModel>,
  fallback: Partial<ProjectedModel> | null,
): CatalogResponse {
  const models = [
    model({
      assignment_id: 'asn_primary',
      alias: 'noul',
      base_url: 'https://expensive.local/v1',
      daily_budget_micros: 1_000_000,
      ...primary,
    }),
  ];
  if (fallback) {
    models.push(
      model({
        assignment_id: 'asn_fallback',
        alias: 'cheap',
        role: 'fallback',
        model: 'cheap-model',
        base_url: 'https://cheap.local/v1',
        api_key: 'k2',
        ...fallback,
      }),
    );
  }
  return {
    project: 'zeus',
    revision: 42,
    fetched_at: '2026-10-31T00:00:00Z',
    models,
  };
}

function summaryFor(
  catalog: CatalogResponse,
  spent: Record<string, number>,
): UsageSummary {
  return {
    project: catalog.project,
    day: '2026-10-31',
    generated_at: '2026-10-31T12:00:00Z',
    models: catalog.models.map((m) => ({
      assignment_id: m.assignment_id,
      alias: m.alias,
      role: m.role,
      model: m.model,
      spent_micros: spent[m.assignment_id] ?? 0,
      daily_budget_micros: m.daily_budget_micros,
      percent: null,
    })),
    unassigned_spent_micros: 0,
  };
}

interface HubStub {
  impl: typeof fetch;
  providerCalls: Array<{ url: string; model: string }>;
  usageReports: Array<Record<string, unknown>>;
  summaryCalls: number;
}

function fakeHub(
  catalog: CatalogResponse,
  getSummary: () => UsageSummary | Response,
): HubStub {
  const providerCalls: Array<{ url: string; model: string }> = [];
  const usageReports: Array<Record<string, unknown>> = [];
  let summaryCalls = 0;
  const impl = (async (input, init) => {
    const url = String(input);
    if (url.includes('/pub/v1/models')) {
      return Response.json(catalog, { status: 200 });
    }
    if (url.includes('/pub/v1/usage/summary')) {
      summaryCalls += 1;
      const value = getSummary();
      return value instanceof Response ? value : Response.json(value);
    }
    if (url.includes('/pub/v1/usage')) {
      usageReports.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Response.json({ accepted: true }, { status: 200 });
    }
    providerCalls.push({
      url,
      model: (JSON.parse(String(init?.body ?? '{}')) as { model?: string })
        .model ?? '',
    });
    return Response.json(
      {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    impl,
    providerCalls,
    usageReports,
    get summaryCalls() {
      return summaryCalls;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-kit-budget-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const chatMessages = [{ role: 'user', content: 'hi' }];

describe('budget readout (W5-1)', () => {
  it('joins hub spend with the assignment limit', async () => {
    const catalog = catalogWith({}, {
      modalities: ['text'],
      daily_budget_micros: null,
    });
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 400_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    kit.stop();

    const state = kit.getDailyBudgetState('noul');
    expect(state).toEqual({
      alias: 'noul',
      assignmentId: 'asn_primary',
      spentMicros: 400_000,
      dailyBudgetMicros: 1_000_000,
      percentUsed: 40,
      exceeded: false,
    });
    // Unknown aliases and unassigned BYOK/env aliases read as null.
    expect(kit.getDailyBudgetState('nope')).toBeNull();
  });

  it('flags exceeded at 100% of the budget', async () => {
    const catalog = catalogWith({}, null);
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_000_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    kit.stop();
    expect(kit.getDailyBudgetState('noul')?.exceeded).toBe(true);
  });

  it('treats an assignment without budget as never exceeded', () => {
    const catalog = catalogWith({ daily_budget_micros: null }, null);
    const state = budgetStateFor(
      catalog.models,
      summaryFor(catalog, { asn_primary: 5_000_000 }),
      'noul',
    );
    expect(state?.exceeded).toBe(false);
    expect(state?.percentUsed).toBeNull();
  });

  it('refreshes the snapshot on the catalog refresh cadence', async () => {
    const catalog = catalogWith({}, null);
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 400_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    expect(hub.summaryCalls).toBe(1);
    await kit.refresh();
    expect(hub.summaryCalls).toBe(2);
    kit.stop();
  });

  it('keeps the previous snapshot when the summary pull fails', async () => {
    const catalog = catalogWith({}, null);
    let failing = false;
    const hub = fakeHub(catalog, () => {
      if (failing) return new Response('boom', { status: 500 });
      return summaryFor(catalog, { asn_primary: 400_000 });
    });
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    failing = true;
    await kit.refresh();
    expect(kit.getDailyBudgetState('noul')?.spentMicros).toBe(400_000);
    kit.stop();
  });
});

describe('budget enforcement (W5-2)', () => {
  it('reroutes to a same-modality fallback and marks the call degraded', async () => {
    const catalog = catalogWith({}, {
      modalities: ['text'],
      daily_budget_micros: null,
    });
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });

    const result = await kit.chat('noul', chatMessages);
    kit.stop();

    // The provider call landed on the fallback endpoint and model.
    expect(hub.providerCalls).toHaveLength(1);
    expect(hub.providerCalls[0]?.url).toContain('https://cheap.local/v1');
    expect(hub.providerCalls[0]?.model).toBe('cheap-model');
    // Result and usage report both carry degradation provenance.
    expect(result.degraded).toEqual({
      reason: 'budget_exceeded',
      requestedAlias: 'noul',
    });
    expect(hub.usageReports[0]?.degraded).toBe(true);
    expect(hub.usageReports[0]?.assignment_id).toBe('asn_fallback');
    expect(hub.usageReports[0]?.model).toBe('cheap-model');
  });

  it('marks the final stream chunk degraded', async () => {
    const catalog = catalogWith({}, {
      modalities: ['text'],
      daily_budget_micros: null,
    });
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });

    const chunks = [];
    for await (const chunk of kit.stream('noul', chatMessages)) {
      chunks.push(chunk);
    }
    kit.stop();

    const last = chunks.at(-1);
    expect(last?.done).toBe(true);
    expect(last?.degraded).toEqual({
      reason: 'budget_exceeded',
      requestedAlias: 'noul',
    });
  });

  it('fails closed with BUDGET_EXCEEDED when no fallback serves the modality', async () => {
    // Only an image fallback exists; text calls cannot degrade into it.
    const catalog = catalogWith({}, {
      modalities: ['image'],
      daily_budget_micros: null,
    });
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    kit.stop();

    await expect(kit.chat('noul', chatMessages)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(hub.providerCalls).toHaveLength(0);
    expect(hub.usageReports).toHaveLength(0);
  });

  it('fails closed when the fallback is over its own budget too', async () => {
    const catalog = catalogWith({}, {
      modalities: ['text'],
      daily_budget_micros: 500_000,
    });
    const hub = fakeHub(
      catalog,
      () =>
        summaryFor(catalog, { asn_primary: 1_200_000, asn_fallback: 600_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    kit.stop();

    await expect(kit.chat('noul', chatMessages)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
      alias: 'noul',
    });
  });

  it('leaves under-budget calls untouched', async () => {
    const catalog = catalogWith({}, {
      modalities: ['text'],
      daily_budget_micros: null,
    });
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 999_999 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });

    const result = await kit.chat('noul', chatMessages);
    kit.stop();
    expect(hub.providerCalls[0]?.url).toContain('https://expensive.local/v1');
    expect(result.degraded).toBeUndefined();
    expect(hub.usageReports[0]?.degraded).toBe(false);
  });

  it('never governs BYOK aliases, even over budget', async () => {
    const catalog = catalogWith({}, null);
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const byok: ResolvedModel = {
      assignmentId: '',
      alias: 'noul',
      role: 'primary',
      modalities: ['text'],
      model: 'user-model',
      litellmId: null,
      displayName: null,
      protocol: 'openai-compatible',
      baseUrl: 'https://user.local/v1',
      apiKey: 'user-key',
      endpoints: { chat: '/chat/completions' },
      adapter: {},
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
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
      resolveByok: () => byok,
    });

    const result = await kit.chat('noul', chatMessages);
    kit.stop();
    expect(hub.providerCalls[0]?.url).toContain('https://user.local/v1');
    expect(result.degraded).toBeUndefined();
  });

  it('does not govern env-fallback aliases', async () => {
    const catalog = catalogWith({}, null);
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
      envFallback: {
        // 'solo' exists only in env, so resolution lands on source 'env'
        // (hub aliases always win over env; those are governed).
        solo: {
          baseUrl: 'https://env.local/v1',
          apiKey: 'env-key',
          model: 'env-model',
        },
      },
    });

    await kit.chat('solo', chatMessages);
    kit.stop();
    expect(hub.providerCalls[0]?.url).toContain('https://env.local/v1');
  });

  it('kill switch option disables the whole layer', async () => {
    const catalog = catalogWith({}, null);
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
      budgetEnforcement: 'off',
    });
    kit.stop();

    // No summary fetch at all, no readout, no enforcement.
    expect(hub.summaryCalls).toBe(0);
    expect(kit.getDailyBudgetState('noul')).toBeNull();
    const result = await kit.chat('noul', chatMessages);
    expect(hub.providerCalls[0]?.url).toContain('https://expensive.local/v1');
    expect(result.degraded).toBeUndefined();
  });

  it('kill switch env MODEL_KIT_BUDGET_ENFORCEMENT=off disables the layer', async () => {
    vi.stubEnv('MODEL_KIT_BUDGET_ENFORCEMENT', 'off');
    const catalog = catalogWith({}, null);
    const hub = fakeHub(
      catalog,
      () => summaryFor(catalog, { asn_primary: 1_200_000 }),
    );
    const kit = await initModelKit({
      token: 'tok',
      hubUrl: 'https://hub.local',
      cachePath: join(dir, 'cache.json'),
      fetch: hub.impl,
    });
    kit.stop();

    expect(hub.summaryCalls).toBe(0);
    await expect(kit.chat('noul', chatMessages)).resolves.toMatchObject({
      content: 'ok',
    });
  });
});
