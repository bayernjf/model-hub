import type {
  DriverFactory,
  PingResult,
  ResolvedModel,
  TestResult,
} from './types.js';

// L3: verify reachability to the hub and a valid project token.
export async function pingHub(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<PingResult> {
  const start = Date.now();
  try {
    const res = await fetchImpl(
      `${hubUrl.replace(/\/+$/, '')}/pub/v1/models`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const latency_ms = Date.now() - start;
    if (res.status === 401) {
      return {
        ok: false,
        latency_ms,
        error: { code: 'unauthorized', hint: 'invalid project token' },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        latency_ms,
        error: { code: 'server_error', hint: `HTTP ${res.status}` },
      };
    }
    const data = (await res.json()) as { revision: number };
    return { ok: true, revision: data.revision, latency_ms };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: {
        code: 'network',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// Minimal openai-compatible text probe used when no driver is injected.
async function defaultProbe(
  model: ResolvedModel,
  fetchImpl: typeof fetch,
): Promise<TestResult> {
  const start = Date.now();
  const path = model.endpoints.chat ?? '/chat/completions';
  const url = `${model.baseUrl.replace(/\/+$/, '')}${path}`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${model.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latency_ms = Date.now() - start;
    if (res.status === 401) {
      return { ok: false, latency_ms, scope: 'L4', error: { code: 'unauthorized' } };
    }
    if (res.status === 404) {
      return { ok: false, latency_ms, scope: 'L4', error: { code: 'model_not_found' } };
    }
    if (!res.ok) {
      return {
        ok: false,
        latency_ms,
        scope: 'L4',
        error: { code: 'server_error', hint: `HTTP ${res.status}` },
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    return {
      ok: Array.isArray(data.choices) && data.choices.length > 0,
      latency_ms,
      scope: 'L4',
      model_echo: data.model,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'L4',
      error: {
        code: 'network',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// L4: exercise a model end to end. Uses the injected driver when present so
// the test runs through the project's real runtime, otherwise the default
// openai-compatible probe.
export async function runTest(
  model: ResolvedModel,
  opts: {
    driverFactory?: DriverFactory | undefined;
    fetchImpl: typeof fetch;
    deep?: boolean | undefined;
  },
): Promise<TestResult> {
  if (opts.driverFactory) {
    return opts.driverFactory(model).probe({ deep: opts.deep });
  }
  return defaultProbe(model, opts.fetchImpl);
}
