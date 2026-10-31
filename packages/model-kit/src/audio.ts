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

export interface TtsResult {
  audio: Uint8Array | null;
  url: string | null;
  httpStatus: number;
  raw: string;
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

  return { audio, url: urlOut, httpStatus: res.status, raw: text };
}
