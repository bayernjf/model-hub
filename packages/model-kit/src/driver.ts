import type {
  DegradationInfo,
  ResolvedModel,
} from './types.js';

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
}

export interface ChatCall {
  model: ResolvedModel;
  messages: ChatMessage[];
  signal?: AbortSignal | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  extra?: Record<string, unknown> | undefined;
}

function chatUrl(model: ResolvedModel): string {
  const path = model.endpoints.chat ?? '/chat/completions';
  return `${model.baseUrl.replace(/\/+$/, '')}${path}`;
}

function headers(model: ResolvedModel): Record<string, string> {
  return {
    Authorization: `Bearer ${model.apiKey}`,
    'Content-Type': 'application/json',
  };
}

// Non-streaming chat completion.
export async function completeJson(
  call: ChatCall,
  fetchImpl: typeof fetch,
): Promise<ChatResult> {
  const res = await fetchImpl(chatUrl(call.model), {
    method: 'POST',
    headers: headers(call.model),
    body: JSON.stringify({
      model: call.model.model,
      messages: call.messages,
      stream: false,
      ...(call.maxTokens != null ? { max_tokens: call.maxTokens } : {}),
      ...(call.temperature != null ? { temperature: call.temperature } : {}),
      ...(call.extra ?? {}),
    }),
    ...(call.signal ? { signal: call.signal } : {}),
  });

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
  };
}

export interface StreamChunk {
  delta: string;
  usage: TokenUsage | null;
  done: boolean;
  /** Set on the final chunk when the call was rerouted to a fallback. */
  degraded?: DegradationInfo | undefined;
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

// Streaming chat completion with include_usage so the final frame carries
// the real token usage. Yields text deltas; the last chunk has usage.
export async function* streamChat(
  call: ChatCall,
  fetchImpl: typeof fetch,
): AsyncGenerator<StreamChunk> {
  const res = await fetchImpl(chatUrl(call.model), {
    method: 'POST',
    headers: headers(call.model),
    body: JSON.stringify({
      model: call.model.model,
      messages: call.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(call.maxTokens != null ? { max_tokens: call.maxTokens } : {}),
      ...(call.temperature != null ? { temperature: call.temperature } : {}),
      ...(call.extra ?? {}),
    }),
    ...(call.signal ? { signal: call.signal } : {}),
  });

  if (!res.body) {
    yield { delta: '', usage: null, done: true };
    return;
  }

  let finalUsage: TokenUsage | null = null;
  for await (const frame of parseSse(res.body)) {
    const data = frame as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: TokenUsage;
    };
    if (data.usage) finalUsage = data.usage;
    const delta = data.choices?.[0]?.delta?.content ?? '';
    if (delta) yield { delta, usage: null, done: false };
  }
  yield { delta: '', usage: finalUsage, done: true };
}
