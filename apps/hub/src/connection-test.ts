/**
 * L1 provider connection tests (hub -> vendor). Tests do not retry, time out
 * after 15s, and never send business data. Results use a single shape and a
 * fixed set of error codes so the UI can show actionable repair hints.
 */
import type { ModelView } from './repositories/models.js';
import { getPresetProvider } from './presets/index.js';
import type { Modality } from './presets/types.js';

export type ErrorCode =
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limited'
  | 'server_error'
  | 'dialect_mismatch';

export interface TestError {
  code: ErrorCode;
  detail?: string | undefined;
  hint?: string | undefined;
}

export interface TestResult {
  ok: boolean;
  latency_ms: number;
  scope: 'provider' | 'model';
  auth_identity?: string | null;
  model_echo?: string | null;
  error?: TestError;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const TEST_TIMEOUT_MS = 15_000;

function classifyStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'model_not_found';
  if (status === 408 || status === 409 || status === 422) return 'dialect_mismatch';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'server_error';
}

function classifyFetchError(err: unknown): ErrorCode {
  if (err instanceof Error && err.name === 'AbortError') return 'network';
  return 'network';
}

async function safeText(res: Response): Promise<string | undefined> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 300) || undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

interface ChatProbeOptions {
  subscription: boolean;
  reasoning: boolean;
  timeoutMs: number;
}

// Minimal chat probe. Reasoning/subscription models need max_tokens >= 32 so
// the request is accepted and reasoning_tokens are returned; other models use
// max_tokens = 1. Subscription providers are accepted on 200 + choices and
// the model echo is not compared (Ark Plan echoes "auto").
async function probeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: ChatProbeOptions,
  fetchImpl: FetchLike,
): Promise<TestResult> {
  const start = Date.now();
  const maxTokens =
    options.reasoning || options.subscription ? 32 : 1;
  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const latency = Date.now() - start;

    if (!res.ok) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'provider',
        error: {
          code: classifyStatus(res.status),
          detail: await safeText(res),
        },
      };
    }

    const data = (await res.json().catch(() => null)) as {
      choices?: unknown;
      model?: unknown;
    } | null;
    if (!data || !Array.isArray(data.choices)) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'provider',
        error: {
          code: 'dialect_mismatch',
          hint: '响应缺少 choices 数组',
        },
      };
    }

    return {
      ok: true,
      latency_ms: latency,
      scope: 'provider',
      model_echo: typeof data.model === 'string' ? data.model : null,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'provider',
      error: {
        code: classifyFetchError(err),
        hint: 'baseUrl 不可达或请求超时',
      },
    };
  }
}

// GET /models auth/visibility probe for image/video-only providers or when
// no chat model is available. A 200 proves the key is accepted.
async function probeModelsList(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/models'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'provider',
        error: {
          code: classifyStatus(res.status),
          detail: await safeText(res),
        },
      };
    }
    return { ok: true, latency_ms: latency, scope: 'provider' };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'provider',
      error: {
        code: classifyFetchError(err),
        hint: 'baseUrl 不可达或请求超时',
      },
    };
  }
}

export interface ProviderTestInput {
  base_url: string;
  api_key: string;
  protocol: string;
  billing_type: string;
  preset_id: string | null;
  /** Models already imported under this provider. */
  models?: ModelView[];
}

function hasModality(model: ModelView, modality: Modality): boolean {
  return model.modalities.includes(modality);
}

// L1 provider test: prefer a minimal chat call when a text model is known
// (imported or inferred from the preset); otherwise fall back to GET /models.
export async function testProvider(
  input: ProviderTestInput,
  fetchImpl: FetchLike = fetch,
): Promise<TestResult> {
  const subscription = input.billing_type === 'subscription';

  // A text model already imported under this provider.
  const importedText = input.models?.find((m) => hasModality(m, 'text'));

  // A text model inferred from the preset (provider may have none imported).
  const preset = input.preset_id
    ? getPresetProvider(input.preset_id)
    : null;
  const presetText = preset?.models.find((m) =>
    m.modalities.includes('text'),
  );

  let chatModel: string | null = null;
  let reasoning = false;
  if (importedText) {
    chatModel = importedText.model;
    reasoning = importedText.reasoning ?? false;
  } else if (presetText) {
    chatModel = presetText.model;
    reasoning = presetText.reasoning ?? false;
  }

  if (chatModel) {
    return probeChat(
      input.base_url,
      input.api_key,
      chatModel,
      {
        subscription,
        reasoning,
        timeoutMs: TEST_TIMEOUT_MS,
      },
      fetchImpl,
    );
  }

  // Image/video-only provider: verify auth via the models list.
  return probeModelsList(
    input.base_url,
    input.api_key,
    TEST_TIMEOUT_MS,
    fetchImpl,
  );
}
