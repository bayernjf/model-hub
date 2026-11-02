import type {
  DegradationInfo,
  ProjectedApiKey,
  ResolvedModel,
} from './types.js';
import {
  AllProviderKeysExhaustedError,
  ProviderRequestError,
  classifyProviderError,
} from './provider-errors.js';

export interface ChatMessage {
  role: string;
  content: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage | null;
  httpStatus: number;
  raw: unknown;
  /** Set when the kit rerouted the call to a fallback (budget governance). */
  degraded?: DegradationInfo | undefined;
  /** Set when the request was retried with another key in the pool. */
  keyFailover?: boolean | undefined;
  /** Pool key id that actually served the request ('' for legacy single key). */
  keyId?: string | undefined;
}

export interface ChatCall {
  model: ResolvedModel;
  messages: ChatMessage[];
  signal?: AbortSignal | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  extra?: Record<string, unknown> | undefined;
  /** Called when a key is identified as quota-exhausted (best-effort report). */
  onKeyExhausted?: KeyExhaustedHandler | undefined;
}

export type KeyExhaustedHandler = (event: {
  keyId: string;
  status: number;
  code: string | null;
}) => void;

function chatUrl(model: ResolvedModel): string {
  const path = model.endpoints.chat ?? '/chat/completions';
  return `${model.baseUrl.replace(/\/+$/, '')}${path}`;
}

// Ordered credentials: prefer the projected pool, fall back to the legacy
// single key. A single-entry list (or an empty pool projected onto apiKey)
// makes the call path identical to the pre-pool behavior.
function credentials(model: ResolvedModel): ProjectedApiKey[] {
  if (model.apiKeys && model.apiKeys.length > 0) return model.apiKeys;
  return [{ key: model.apiKey, keyId: '', label: '' }];
}

function requestBody(call: ChatCall): Record<string, unknown> {
  return {
    model: call.model.model,
    messages: call.messages,
    stream: false,
    ...(call.maxTokens != null ? { max_tokens: call.maxTokens } : {}),
    ...(call.temperature != null ? { temperature: call.temperature } : {}),
    ...(call.extra ?? {}),
  };
}

function streamBody(call: ChatCall): Record<string, unknown> {
  return {
    model: call.model.model,
    messages: call.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(call.maxTokens != null ? { max_tokens: call.maxTokens } : {}),
    ...(call.temperature != null ? { temperature: call.temperature } : {}),
    ...(call.extra ?? {}),
  };
}

async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return (await res.clone().json()) as unknown;
  } catch {
    return null;
  }
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as {
      error?: { code?: unknown };
      code?: unknown;
    };
    const code = b.error?.code ?? b.code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

// Non-streaming chat completion with in-request credential failover.
export async function completeJson(
  call: ChatCall,
  fetchImpl: typeof fetch,
): Promise<ChatResult> {
  const creds = credentials(call.model);
  let last: { status: number; body: unknown } | null = null;
  let failedOver = false;

  for (let i = 0; i < creds.length; i += 1) {
    const cred = creds[i]!;
    const res = await fetchImpl(chatUrl(call.model), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cred.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(call)),
      ...(call.signal ? { signal: call.signal } : {}),
    });

    if (res.ok) {
      const raw = await res.json();
      const data = raw as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: TokenUsage;
      };
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        usage: data.usage ?? null,
        httpStatus: res.status,
        raw,
        ...(failedOver ? { keyFailover: true } : {}),
        keyId: cred.keyId,
      };
    }

    const body = await readErrorBody(res);
    const kind = classifyProviderError(res.status, body);
    last = { status: res.status, body };

    if (kind === 'quota_exhausted' && i + 1 < creds.length && cred.keyId) {
      call.onKeyExhausted?.({ keyId: cred.keyId, status: res.status, code: errorCode(body) });
      failedOver = true;
      continue; // replay the identical request with the next key
    }
    // A real pool key (non-empty id) with no successor is fully exhausted.
    // A legacy single key (keyId '') must surface the provider response just
    // like pre-pool behavior, not the pool error — fall through below.
    if (kind === 'quota_exhausted' && cred.keyId) {
      call.onKeyExhausted?.({ keyId: cred.keyId, status: res.status, code: errorCode(body) });
      throw new AllProviderKeysExhaustedError(res.status, body);
    }
    // rate_limited, 401/403/5xx: surface the provider error; no rotation.
    return {
      content: '',
      usage: null,
      httpStatus: res.status,
      raw: body,
      ...(failedOver ? { keyFailover: true } : {}),
      keyId: cred.keyId,
    };
  }

  // Unreachable in practice (loop returns or throws).
  throw new AllProviderKeysExhaustedError(
    last?.status ?? 0,
    last?.body ?? null,
  );
}

export interface StreamChunk {
  delta: string;
  usage: TokenUsage | null;
  done: boolean;
  /** Set on the final chunk when the call was rerouted to a fallback. */
  degraded?: DegradationInfo | undefined;
  /** Set on chunks after a credential failover. */
  keyFailover?: boolean | undefined;
}

// Parse SSE `data:` lines from a stream into chunk objects.
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // ignore malformed SSE frame
      }
    }
  }
}

// Open the stream with one credential. Returns null when the response is a
// quota-class 429 (headers stage, no bytes consumed) so the caller can retry
// with the next key; throws/returns the error response for anything else.
async function openStream(
  call: ChatCall,
  cred: ProjectedApiKey,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; res: Response; keyId: string }
  | { ok: false; exhausted: boolean; status: number; body: unknown; keyId: string }
> {
  const res = await fetchImpl(chatUrl(call.model), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(streamBody(call)),
    ...(call.signal ? { signal: call.signal } : {}),
  });
  if (res.ok) return { ok: true, res, keyId: cred.keyId };
  const body = await readErrorBody(res);
  const kind = classifyProviderError(res.status, body);
  return {
    ok: false,
    exhausted: kind === 'quota_exhausted',
    status: res.status,
    body,
    keyId: cred.keyId,
  };
}

// Streaming chat with key failover at the HEADER stage only. Once a 200 stream
// begins yielding content, a later 429 is surfaced (mid-body replay would
// duplicate output). include_usage puts real usage on the final frame.
export async function* streamChat(
  call: ChatCall,
  fetchImpl: typeof fetch,
): AsyncGenerator<StreamChunk> {
  const creds = credentials(call.model);
  let opened: { res: Response; keyId: string } | null = null;
  let failedOver = false;

  for (let i = 0; i < creds.length; i += 1) {
    const attempt = await openStream(call, creds[i]!, fetchImpl);
    if (attempt.ok) {
      opened = { res: attempt.res, keyId: attempt.keyId };
      break;
    }
    if (attempt.exhausted && i + 1 < creds.length && attempt.keyId) {
      call.onKeyExhausted?.({
        keyId: attempt.keyId,
        status: attempt.status,
        code: errorCode(attempt.body),
      });
      failedOver = true;
      continue;
    }
    // A real pool with no successor is fully exhausted; a legacy single key
    // (empty id) surfaces a plain provider error (pre-pool behavior).
    if (attempt.exhausted && attempt.keyId) {
      call.onKeyExhausted?.({
        keyId: attempt.keyId,
        status: attempt.status,
        code: errorCode(attempt.body),
      });
      throw new AllProviderKeysExhaustedError(attempt.status, attempt.body);
    }
    // Non-quota failure (ordinary 429 / 401 / 403 / 5xx): no failover, surface
    // it. A mid-stream 429 would also land here as a non-SSE response at open.
    throw new ProviderRequestError(attempt.status, attempt.body);
  }

  if (!opened || !opened.res.body) {
    yield { delta: '', usage: null, done: true };
    return;
  }

  let finalUsage: TokenUsage | null = null;
  for await (const frame of parseSse(opened.res.body)) {
    const data = frame as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: TokenUsage;
    };
    if (data.usage) finalUsage = data.usage;
    const delta = data.choices?.[0]?.delta?.content ?? '';
    if (delta) yield { delta, usage: null, done: false, ...(failedOver ? { keyFailover: true } : {}) };
  }
  yield { delta: '', usage: finalUsage, done: true, ...(failedOver ? { keyFailover: true } : {}) };
}
