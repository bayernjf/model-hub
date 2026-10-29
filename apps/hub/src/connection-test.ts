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
  auth_identity?: string | null | undefined;
  model_echo?: string | null | undefined;
  error?: TestError | undefined;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const TEST_TIMEOUT_MS = 15_000;
// Image/video generation can legitimately take tens of seconds (a real
// Seedream generation measured ~13.5s); the 15s chat timeout is too tight.
export const GENERATION_TIMEOUT_MS = 60_000;

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

// Minimal embedding probe; a 200 with a data array proves the model works.
async function probeEmbed(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const res = await fetchImpl(joinUrl(baseUrl, '/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: 'hi' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'model',
        error: {
          code: classifyStatus(res.status),
          detail: await safeText(res),
        },
      };
    }
    const data = (await res.json().catch(() => null)) as {
      data?: unknown;
    } | null;
    if (!data || !Array.isArray(data.data)) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'model',
        error: { code: 'dialect_mismatch', hint: '响应缺少 data 数组' },
      };
    }
    return { ok: true, latency_ms: latency, scope: 'model' };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'model',
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

// Minimal TTS probe. Doubao voice (openspeech) uses X-Api-Key single-header
// auth, an X-Api-Resource-Id header and a non-standard req_params body whose
// response is chunked JSON with base64 `data` fields; OpenAI-compatible TTS
// uses Bearer auth and returns JSON (url) or raw audio. The adapter carries
// auth_style / resource_id / submit_path / create_body (speaker, ...).
async function probeTts(
  baseUrl: string,
  apiKey: string,
  model: ModelView,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<TestResult> {
  const a = model.adapter;
  const path =
    a?.submit_path ??
    model.endpoints_override?.audio ??
    '/v1/audio/speech';
  const xApiKey = a?.auth_style === 'x-api-key';
  const start = Date.now();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (xApiKey) {
      headers['X-Api-Key'] = apiKey;
      if (a?.resource_id) headers['X-Api-Resource-Id'] = a.resource_id;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const createBody = a?.create_body ?? {};
    const body = xApiKey
      ? { req_params: { text: 'hi', ...createBody } }
      : { model: model.model, input: 'hi', ...createBody };
    const res = await fetchImpl(joinUrl(baseUrl, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'model',
        error: {
          code: classifyStatus(res.status),
          detail: await safeText(res),
        },
      };
    }
    const text = await res.text();
    if (xApiKey) {
      // Semantic errors arrive as HTTP 200 with a non-zero code.
      const codeMatch = /"code"\s*:\s*(\d+)/.exec(text);
      if (codeMatch && codeMatch[1] !== '0') {
        return {
          ok: false,
          latency_ms: latency,
          scope: 'model',
          error: {
            code: 'dialect_mismatch',
            detail: text.slice(0, 300),
            hint: '语音端点返回语义错误，检查 resource_id / body 方言',
          },
        };
      }
      const parts: string[] = [];
      const re = /"data"\s*:\s*"([A-Za-z0-9+/=]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) parts.push(m[1]!);
      if (parts.length === 0) {
        return {
          ok: false,
          latency_ms: latency,
          scope: 'model',
          error: { code: 'dialect_mismatch', hint: '响应缺少 base64 音频块' },
        };
      }
      return { ok: true, latency_ms: latency, scope: 'model' };
    }
    // Bearer dialect: a 200 is accepted regardless of body shape (JSON url or
    // raw audio); a JSON error object with no audio/url is still accepted as a
    // provider-level success for OpenAI-style TTS.
    return { ok: true, latency_ms: latency, scope: 'model' };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'model',
      error: { code: classifyFetchError(err) },
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

  // Voice-only provider (e.g. openspeech): synthesize a minimal clip as the
  // auth/connectivity probe when an audio model is known.
  const importedAudio = input.models?.find((m) => hasModality(m, 'audio'));
  const presetAudio = preset?.models.find((m) =>
    m.modalities.includes('audio'),
  );
  const audioModel = importedAudio ?? presetAudio;
  if (audioModel) {
    const modelView: ModelView = {
      id: audioModel.id,
      provider_id: 'preset',
      preset_model_id: audioModel.id,
      model: audioModel.model,
      display_name: audioModel.display_name ?? null,
      modalities: audioModel.modalities,
      litellm_id: audioModel.litellm_id ?? null,
      context_window: audioModel.context_window ?? null,
      supports_json: audioModel.supports_json,
      supports_stream: audioModel.supports_stream,
      pricing: audioModel.pricing ?? {},
      endpoints_override: null,
      adapter: audioModel.adapter ?? null,
      is_default: false,
      sort_order: 0,
      enabled: true,
      reasoning: audioModel.reasoning ?? false,
      created_at: '',
      updated_at: '',
    };
    return probeTts(
      input.base_url,
      input.api_key,
      modelView,
      TEST_TIMEOUT_MS,
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

// Deep image probe: one minimal paid generation.
async function probeImageGenerate(
  baseUrl: string,
  apiKey: string,
  model: ModelView,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<TestResult> {
  const path = model.endpoints_override?.images ?? '/images/generations';
  const start = Date.now();
  try {
    const res = await fetchImpl(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        prompt: 'test',
        n: 1,
        size: '1024x1024',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'model',
        error: {
          code: classifyStatus(res.status),
          detail: await safeText(res),
        },
      };
    }
    return { ok: true, latency_ms: latency, scope: 'model' };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'model',
      error: { code: classifyFetchError(err) },
    };
  }
}

// Deep video probe: submit the task exactly once and return on acceptance;
// never poll or resubmit (the loom no-retry-on-spend rule).
async function probeVideoSubmit(
  baseUrl: string,
  apiKey: string,
  model: ModelView,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<TestResult> {
  const path = model.endpoints_override?.videos ?? '/videos';
  const start = Date.now();
  // Video submit bodies differ per provider: the default is {model, prompt, duration};
  // an adapter supplies create_body / seconds_field / omit_duration for its dialect
  // (Agnes uses seconds + mode + size and rejects a `duration` field).
  const adapter = model.adapter;
  const body: Record<string, unknown> = { model: model.model, prompt: 'test' };
  if (adapter?.create_body) Object.assign(body, adapter.create_body);
  if (!adapter?.omit_duration) {
    const durField = adapter?.seconds_field ?? 'duration';
    const [lo, hi] = adapter?.seconds_range ?? [4, 12];
    const durValue = adapter?.seconds_field
      ? String(Math.min(hi, Math.max(lo, 5)))
      : 1;
    body[durField] = durValue;
  }
  try {
    const res = await fetchImpl(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (res.status !== 200 && res.status !== 201) {
      return {
        ok: false,
        latency_ms: latency,
        scope: 'model',
        error: {
          code: classifyStatus(res.status),
          detail: await safeText(res),
        },
      };
    }
    return { ok: true, latency_ms: latency, scope: 'model' };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      scope: 'model',
      error: { code: classifyFetchError(err) },
    };
  }
}

export interface ModelTestInput {
  base_url: string;
  api_key: string;
  billing_type: string;
  model: ModelView;
  deep: boolean;
}

// L2 single-model test. Text models make a real minimal call (max_tokens=1,
// or 32 for reasoning models) and the model echo is compared for
// non-subscription providers. Image/video models are free visibility probes
// by default; deep performs one paid generation / one video submission.
export async function testModel(
  input: ModelTestInput,
  fetchImpl: FetchLike = fetch,
): Promise<TestResult> {
  const subscription = input.billing_type === 'subscription';
  const model = input.model;

  if (model.modalities.includes('text')) {
    const result = await probeChat(
      input.base_url,
      input.api_key,
      model.model,
      {
        subscription,
        reasoning: model.reasoning,
        timeoutMs: TEST_TIMEOUT_MS,
      },
      fetchImpl,
    );
    const scoped: TestResult = { ...result, scope: 'model' };

    if (scoped.ok && !subscription && scoped.model_echo !== model.model) {
      return {
        ok: false,
        latency_ms: scoped.latency_ms,
        scope: 'model',
        model_echo: scoped.model_echo,
        error: {
          code: 'dialect_mismatch',
          detail: `模型回显 "${scoped.model_echo ?? ''}" 与配置 "${model.model}" 不符`,
          hint: '检查模型 ID 或端点配置',
        },
      };
    }
    return scoped;
  }

  if (model.modalities.includes('embedding')) {
    return probeEmbed(
      input.base_url,
      input.api_key,
      model.model,
      TEST_TIMEOUT_MS,
      fetchImpl,
    );
  }

  if (model.modalities.includes('audio')) {
    return probeTts(
      input.base_url,
      input.api_key,
      model,
      GENERATION_TIMEOUT_MS,
      fetchImpl,
    );
  }

  if (
    model.modalities.includes('image') ||
    model.modalities.includes('video')
  ) {
    if (!input.deep) {
      const result = await probeModelsList(
        input.base_url,
        input.api_key,
        TEST_TIMEOUT_MS,
        fetchImpl,
      );
      return { ...result, scope: 'model' };
    }
    if (model.modalities.includes('video')) {
      return probeVideoSubmit(
        input.base_url,
        input.api_key,
        model,
        GENERATION_TIMEOUT_MS,
        fetchImpl,
      );
    }
    return probeImageGenerate(
      input.base_url,
      input.api_key,
      model,
      GENERATION_TIMEOUT_MS,
      fetchImpl,
    );
  }

  return {
    ok: false,
    latency_ms: 0,
    scope: 'model',
    error: { code: 'dialect_mismatch', hint: '模型没有可测试的模态' },
  };
}
