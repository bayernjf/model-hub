import { Buffer } from 'node:buffer';
import type { DegradationInfo, ResolvedModel } from './types.js';

// Text-to-speech (HTTP). Doubao voice uses X-Api-Key single-header auth and a
// chunked JSON response whose `data` fields are base64 audio; OpenAI-compatible
// TTS uses Bearer auth and may return JSON (url) or raw audio. The adapter
// carries auth_style / resource_id / submit_path / create_body (speaker, ...).

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

// Opt-in header from the Agent Plan voice doc; without it the TTS response
// carries no token usage, so spend cannot be accounted for.
const USAGE_TOKENS_HEADER = 'X-Control-Require-Usage-Tokens-Return';
const USAGE_TOKENS_VALUE = '*';

// Provider candidates for the token count inside a `usage` object. Only a
// numeric value is accepted; nothing is inferred when the field is absent.
const USAGE_TOKEN_FIELDS = ['total_tokens', 'tokens', 'usage_tokens'] as const;

// The Doubao HTTP TTS response is newline-delimited JSON chunks. Collect the
// first `usage` object it reports, if any.
function readUsage(text: string): Record<string, unknown> | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { usage?: unknown };
      if (
        typeof parsed.usage === 'object' &&
        parsed.usage !== null &&
        !Array.isArray(parsed.usage)
      ) {
        return parsed.usage as Record<string, unknown>;
      }
    } catch {
      // Ignore non-JSON segments; audio decoding below is unaffected.
    }
  }
  return null;
}

function readUsageTokens(usage: Record<string, unknown> | null): number | null {
  if (!usage) return null;
  for (const field of USAGE_TOKEN_FIELDS) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export interface TtsResult {
  audio: Uint8Array | null;
  url: string | null;
  httpStatus: number;
  raw: string;
  /** Token count echoed by the provider, when its usage field carries one. */
  usageTokens: number | null;
  /** Raw provider `usage` object (shape owned by the provider); null if absent. */
  usage: Record<string, unknown> | null;
  /** Set when the kit rerouted the call to a fallback (budget governance). */
  degraded?: DegradationInfo | undefined;
}

export interface TtsCall {
  model: ResolvedModel;
  text: string;
  signal?: AbortSignal | undefined;
}

export async function synthesize(
  call: TtsCall,
  fetchImpl: typeof fetch,
): Promise<TtsResult> {
  const a = call.model.adapter;
  const path =
    a?.submit_path ??
    call.model.endpoints.audio ??
    '/api/v3/plan/tts/unidirectional';
  const url = joinUrl(call.model.baseUrl, path);
  const xApiKey = a?.auth_style === 'x-api-key';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (xApiKey) {
    headers['X-Api-Key'] = call.model.apiKey;
    if (a?.resource_id) headers['X-Api-Resource-Id'] = a.resource_id;
    headers[USAGE_TOKENS_HEADER] = USAGE_TOKENS_VALUE;
  } else {
    headers['Authorization'] = `Bearer ${call.model.apiKey}`;
  }

  const createBody = a?.create_body ?? {};
  const body = xApiKey
    ? { req_params: { text: call.text, ...createBody } }
    : { model: call.model.model, input: call.text, ...createBody };

  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(call.signal ? { signal: call.signal } : {}),
  });

  const text = await res.text();
  const usage = readUsage(text);
  const usageTokens = readUsageTokens(usage);

  let audio: Uint8Array | null = null;
  let urlOut: string | null = null;
  if (xApiKey) {
    // Chunked JSON: {"code":0,"data":"<base64>"} possibly repeated.
    const parts: string[] = [];
    const re = /"data":"([A-Za-z0-9+/=]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) parts.push(m[1]!);
    if (parts.length > 0) {
      audio = new Uint8Array(Buffer.from(parts.join(''), 'base64'));
    }
  } else {
    try {
      const j = JSON.parse(text) as { data?: Array<{ url?: string }> };
      urlOut = j.data?.[0]?.url ?? null;
    } catch {
      // Non-JSON body: treat as raw audio bytes (already text-decoded, lossy for
      // binary formats; projects needing raw bytes should use a real client).
      audio = new TextEncoder().encode(text);
    }
  }

  return { audio, url: urlOut, httpStatus: res.status, raw: text, usage, usageTokens };
}
