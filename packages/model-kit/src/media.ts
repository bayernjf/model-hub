import type { ResolvedModel } from './types.js';

// Non-text modality drivers. Text/embedding/image are synchronous request-
// response; video is an async submit-then-poll flow driven by the adapter
// dialect. Audio (TTS/ASR) lives separately because it uses a different auth
// header and WebSocket/streaming protocols.

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function bearerHeaders(model: ResolvedModel): Record<string, string> {
  return {
    Authorization: `Bearer ${model.apiKey}`,
    'Content-Type': 'application/json',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export interface EmbedUsage {
  prompt_tokens: number;
  total_tokens: number;
}

export interface EmbedResult {
  vectors: number[][];
  /** Token usage echoed by the provider; null when the response omits it. */
  usage: EmbedUsage | null;
  httpStatus: number;
  raw: unknown;
}

export interface EmbedCall {
  model: ResolvedModel;
  input: string | string[];
  signal?: AbortSignal | undefined;
}

// Extract the usage block from an embeddings response. Providers that skip
// it (or return malformed shapes) yield null so callers can still proceed.
function embedUsage(raw: { usage?: { prompt_tokens?: unknown; total_tokens?: unknown } }): EmbedUsage | null {
  const usage = raw.usage;
  if (!usage || typeof usage.prompt_tokens !== 'number') return null;
  return {
    prompt_tokens: usage.prompt_tokens,
    total_tokens:
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : usage.prompt_tokens,
  };
}

export async function embedJson(
  call: EmbedCall,
  fetchImpl: typeof fetch,
): Promise<EmbedResult> {
  const url = joinUrl(
    call.model.baseUrl,
    call.model.endpoints.embeddings ?? '/embeddings',
  );
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: bearerHeaders(call.model),
    body: JSON.stringify({ model: call.model.model, input: call.input }),
    ...(call.signal ? { signal: call.signal } : {}),
  });
  const raw = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
  };
  return {
    vectors: (raw.data ?? []).map((d) => d.embedding ?? []),
    usage: embedUsage(raw),
    httpStatus: res.status,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Image generation (synchronous)
// ---------------------------------------------------------------------------

export interface ImageResult {
  url: string | null;
  httpStatus: number;
  raw: unknown;
}

export interface ImageCall {
  model: ResolvedModel;
  prompt: string;
  size?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function generateImage(
  call: ImageCall,
  fetchImpl: typeof fetch,
): Promise<ImageResult> {
  const url = joinUrl(
    call.model.baseUrl,
    call.model.endpoints.images ?? '/images/generations',
  );
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: bearerHeaders(call.model),
    body: JSON.stringify({
      model: call.model.model,
      prompt: call.prompt,
      n: 1,
      size: call.size ?? '1024x1024',
    }),
    ...(call.signal ? { signal: call.signal } : {}),
  });
  const raw = (await res.json()) as { data?: Array<{ url?: string }> };
  return {
    url: raw.data?.[0]?.url ?? null,
    httpStatus: res.status,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Video generation (async submit + poll)
// ---------------------------------------------------------------------------

export interface VideoResult {
  url: string | null;
  jobId: string | null;
  httpStatus: number;
  raw: unknown;
}

export interface VideoCall {
  model: ResolvedModel;
  prompt: string;
  signal?: AbortSignal | undefined;
  pollTimeoutMs?: number | undefined;
}

// Build the submit body from the adapter dialect (seconds/mode/size rather than
// a hardcoded `duration`, which providers like Agnes reject).
function videoSubmitBody(
  model: ResolvedModel,
  prompt: string,
): Record<string, unknown> {
  const a = model.adapter;
  const body: Record<string, unknown> = { model: model.model, prompt };
  if (a?.create_body) Object.assign(body, a.create_body);
  if (!a?.omit_duration) {
    const field = a?.seconds_field ?? 'duration';
    const [lo, hi] = a?.seconds_range ?? [4, 12];
    const value = a?.seconds_field
      ? String(Math.min(hi, Math.max(lo, 5)))
      : 1;
    body[field] = value;
  }
  return body;
}

function extractUrl(data: Record<string, unknown>, path?: string): string | null {
  if (!path) return (data['url'] as string | undefined) ?? null;
  let cur: unknown = data;
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return typeof cur === 'string' ? cur : null;
}

export async function generateVideo(
  call: VideoCall,
  fetchImpl: typeof fetch,
): Promise<VideoResult> {
  const a = call.model.adapter;
  const submitPath = a?.submit_path ?? call.model.endpoints.videos ?? '/videos';
  const submitUrl = joinUrl(call.model.baseUrl, submitPath);

  const submitRes = await fetchImpl(submitUrl, {
    method: 'POST',
    headers: bearerHeaders(call.model),
    body: JSON.stringify(videoSubmitBody(call.model, call.prompt)),
    ...(call.signal ? { signal: call.signal } : {}),
  });
  const submitRaw = (await submitRes.json()) as Record<string, unknown>;

  const idField = a?.id_field ?? 'id';
  const jobId =
    (submitRaw[idField] as string | undefined) ??
    (submitRaw['video_id'] as string | undefined) ??
    (submitRaw['task_id'] as string | undefined) ??
    null;

  // No poll template/path → submit-only (verified acceptance, no result URL).
  if (!a?.retrieval_url_template && !a?.poll_path) {
    return { url: null, jobId, httpStatus: submitRes.status, raw: submitRaw };
  }

  let pollUrl: string;
  if (a?.retrieval_url_template) {
    pollUrl = a.retrieval_url_template
      .replaceAll('{jobId}', jobId ?? '')
      .replaceAll('{id}', jobId ?? '')
      .replaceAll('{model}', call.model.model);
    if (!/^https?:\/\//.test(pollUrl)) {
      pollUrl = joinUrl(call.model.baseUrl, pollUrl);
    }
  } else {
    pollUrl = joinUrl(
      call.model.baseUrl,
      (a!.poll_path ?? '').replaceAll('{id}', jobId ?? ''),
    );
  }

  const statusField = a?.status_field ?? 'status';
  const succeeded = a?.succeeded_values ?? ['completed', 'succeeded', 'success'];
  const failed = a?.failed_values ?? ['failed', 'error', 'cancelled'];
  const interval = a?.poll_interval_ms ?? 2000;
  const deadline = Date.now() + (call.pollTimeoutMs ?? 120_000);

  while (Date.now() < deadline) {
    if (call.signal?.aborted) break;
    await sleep(interval);
    const pollRes = await fetchImpl(pollUrl, {
      method: 'GET',
      headers: bearerHeaders(call.model),
      ...(call.signal ? { signal: call.signal } : {}),
    });
    const pollRaw = (await pollRes.json()) as Record<string, unknown>;
    const status = String(pollRaw[statusField] ?? '').toLowerCase();
    if (succeeded.includes(status)) {
      return {
        url: extractUrl(pollRaw, a?.result_url_path),
        jobId,
        httpStatus: pollRes.status,
        raw: pollRaw,
      };
    }
    if (failed.includes(status)) {
      return { url: null, jobId, httpStatus: pollRes.status, raw: pollRaw };
    }
  }

  return { url: null, jobId, httpStatus: submitRes.status, raw: submitRaw };
}
