import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import type { ResolvedModel } from './types.js';

// Automatic speech recognition (ASR) over the Volcano/ByteDance SAUC binary
// protocol (Agent Plan). The handshake carries X-Api-Key / X-Api-Resource-Id;
// frames are a 4-byte header + 4-byte BE sequence + 4-byte BE payload size +
// a gzip-compressed payload. Reference: Volcano Ark "接入语音模型".
//
// The transport is injected (AsrSocketFactory) so the flow is testable
// without a live server; the default factory uses the `ws` package.

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 0x1;
// Header size in 4-byte units. The fixed header is 4 bytes (no extensions).
const HEADER_SIZE_UNITS = 0x1;

const MESSAGE_TYPE = {
  CLIENT_FULL_REQUEST: 0x1,
  CLIENT_AUDIO_ONLY_REQUEST: 0x2,
  SERVER_FULL_RESPONSE: 0x9,
  SERVER_ERROR_RESPONSE: 0xf,
} as const;

const FLAGS = {
  NO_SEQUENCE: 0x0,
  POS_SEQUENCE: 0x1,
  NEG_SEQUENCE: 0x2,
  NEG_WITH_SEQUENCE: 0x3,
} as const;

const SERIALIZATION_JSON = 0x1;
const COMPRESSION_GZIP = 0x1;

// ---------------------------------------------------------------------------
// Frame builders (client → server)
// ---------------------------------------------------------------------------

function buildHeader(messageType: number, flags: number): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS;
  header[1] = (messageType << 4) | flags;
  header[2] = (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP;
  header[3] = 0x00;
  return header;
}

export interface AsrAudioConfig {
  format: string;
  codec: string;
  rate: number;
  bits: number;
  channel: number;
}

// Frame 1: full client request describing the audio and recognition options.
export function buildFullRequest(
  seq: number,
  sections: {
    uid: string;
    audio: AsrAudioConfig;
    request: Record<string, unknown>;
  },
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      user: { uid: sections.uid },
      audio: sections.audio,
      request: sections.request,
    }),
  );
  const compressed = gzipSync(payload);
  const meta = Buffer.alloc(8);
  meta.writeInt32BE(seq, 0);
  meta.writeUInt32BE(compressed.length, 4);
  return Buffer.concat([
    buildHeader(MESSAGE_TYPE.CLIENT_FULL_REQUEST, FLAGS.POS_SEQUENCE),
    meta,
    compressed,
  ]);
}

// Frames 2..N: audio-only chunks. The final chunk uses negative sequence with
// the NEG_WITH_SEQUENCE flag so the server knows the upload is complete.
export function buildAudioOnly(
  seq: number,
  pcm: Uint8Array,
  isLast: boolean,
): Buffer {
  const compressed = gzipSync(Buffer.from(pcm));
  const flags = isLast ? FLAGS.NEG_WITH_SEQUENCE : FLAGS.POS_SEQUENCE;
  const seqValue = isLast ? -seq : seq;
  const meta = Buffer.alloc(8);
  meta.writeInt32BE(seqValue, 0);
  meta.writeUInt32BE(compressed.length, 4);
  return Buffer.concat([
    buildHeader(MESSAGE_TYPE.CLIENT_AUDIO_ONLY_REQUEST, flags),
    meta,
    compressed,
  ]);
}

// ---------------------------------------------------------------------------
// Frame parser (server → client)
// ---------------------------------------------------------------------------

export interface ParsedAsrFrame {
  messageType: number;
  flags: number;
  isLastPackage: boolean;
  sequence: number | null;
  event: number | null;
  code: number | null;
  payload: unknown;
}

export function parseFrame(msg: Uint8Array): ParsedAsrFrame {
  const buf = Buffer.from(msg);
  if (buf.length < 4) {
    return {
      messageType: 0,
      flags: 0,
      isLastPackage: false,
      sequence: null,
      event: null,
      code: null,
      payload: null,
    };
  }
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const b2 = buf[2]!;
  const headerSizeUnits = b0 & 0x0f;
  const messageType = b1 >> 4;
  const flags = b1 & 0x0f;
  const serialization = b2 >> 4;
  const compression = b2 & 0x0f;

  const out: ParsedAsrFrame = {
    messageType,
    flags,
    isLastPackage: false,
    sequence: null,
    event: null,
    code: null,
    payload: null,
  };

  let payload = buf.subarray(headerSizeUnits * 4);
  if (payload.length < 4) return out;

  // Flag bit 0: positive sequence present.
  if (flags & 0x01) {
    out.sequence = payload.readInt32BE(0);
    payload = payload.subarray(4);
  }
  // Flag bit 1: last package marker.
  if (flags & 0x02) out.isLastPackage = true;
  // Flag bit 2: event field present.
  if (flags & 0x04) {
    out.event = payload.readInt32BE(0);
    payload = payload.subarray(4);
  }

  if (messageType === MESSAGE_TYPE.SERVER_FULL_RESPONSE) {
    const size = payload.readUInt32BE(0);
    payload = payload.subarray(4, 4 + size);
  } else if (messageType === MESSAGE_TYPE.SERVER_ERROR_RESPONSE) {
    out.code = payload.readInt32BE(0);
    const size = payload.readUInt32BE(4);
    payload = payload.subarray(8, 8 + size);
  }

  if (payload.length === 0) return out;

  if (compression === COMPRESSION_GZIP) {
    try {
      payload = Buffer.from(gunzipSync(payload));
    } catch {
      // Corrupt compression: leave payload null rather than throw into the
      // recognition loop; the caller decides whether the missing text matters.
      return out;
    }
  }
  if (serialization === SERIALIZATION_JSON) {
    try {
      out.payload = JSON.parse(payload.toString('utf8'));
    } catch {
      // malformed JSON: leave payload null
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// WAV parsing (PCM extraction)
// ---------------------------------------------------------------------------

export interface WavData {
  pcm: Buffer;
  rate: number;
  bits: number;
  channels: number;
}

// Extract the raw PCM data chunk from a WAV file. Throws on non-WAV input or
// a missing data chunk. Non-WAV audio must be converted beforehand (ffmpeg).
export function parseWav(data: Uint8Array): WavData {
  const buf = Buffer.from(data);
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('invalid WAV: not a RIFF/WAVE file');
  }
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'data') {
      return {
        pcm: buf.subarray(pos + 8, pos + 8 + size),
        rate,
        bits,
        channels,
      };
    }
    // Chunks are word-aligned; skip a padding byte for odd sizes.
    pos += 8 + size + (size % 2);
  }
  throw new Error('invalid WAV: no data chunk');
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export interface AsrSocket {
  send(frame: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export type AsrSocketFactory = (
  url: string,
  handshakeHeaders: Record<string, string>,
) => AsrSocket;

function toUint8(data: unknown): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Buffer);
}

// Default Node transport using the `ws` package, which supports custom
// handshake headers (the global WebSocket in Node does not).
export const nodeWsFactory: AsrSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  return {
    send: (frame) => {
      ws.send(frame);
    },
    close: () => {
      ws.close();
    },
    onOpen: (cb) => {
      ws.on('open', cb);
    },
    onMessage: (cb) => {
      ws.on('message', (data) => {
        cb(toUint8(data));
      });
    },
    onError: (cb) => {
      ws.on('error', cb);
    },
    onClose: (cb) => {
      ws.on('close', (code, reason) => {
        cb(code ?? 1000, reason?.toString() ?? '');
      });
    },
  };
};

// ---------------------------------------------------------------------------
// High-level recognition flow
// ---------------------------------------------------------------------------

export interface AsrUtterance {
  text: string;
  start_time?: number;
  end_time?: number;
  definite?: boolean;
}

export interface AsrResult {
  text: string;
  utterances: AsrUtterance[];
  frames: ParsedAsrFrame[];
}

export interface TranscribeCall {
  model: ResolvedModel;
  // WAV bytes by default; raw PCM with rawPcm: true (16kHz/16bit/mono assumed).
  audio: Uint8Array;
  rawPcm?: boolean | undefined;
  uid?: string | undefined;
  // Upload chunk size in ms (default 200ms).
  chunkMs?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  // Extra fields merged into the request section of the full request.
  request?: Record<string, unknown> | undefined;
}

function toWsUrl(baseUrl: string, path: string): string {
  const base = baseUrl
    .replace(/\/+$/, '')
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

interface AsrResultPayload {
  result?: {
    text?: string;
    utterances?: Array<AsrUtterance>;
  };
}

function collect(frames: ParsedAsrFrame[]): AsrResult {
  const utterances: AsrUtterance[] = [];
  for (const f of frames) {
    const list = (f.payload as AsrResultPayload | null)?.result?.utterances;
    if (Array.isArray(list)) {
      for (const u of list) {
        if (u && typeof u.text === 'string') utterances.push(u);
      }
    }
  }
  // Streaming frames carry cumulative text; the last frame with text wins.
  // Nostream returns a single frame with the complete text.
  let text = '';
  for (let i = frames.length - 1; i >= 0; i--) {
    const t = (frames[i]!.payload as AsrResultPayload | null)?.result?.text;
    if (typeof t === 'string') {
      text = t;
      break;
    }
  }
  if (!text && utterances.length > 0) {
    text = utterances.map((u) => u.text).join('');
  }
  return { text, utterances, frames };
}

export class AsrError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'AsrError';
  }
}

// Run the full recognition: handshake → full request → chunked audio →
// last packet → collect responses until the server's last package.
export async function transcribe(
  call: TranscribeCall,
  socketFactory: AsrSocketFactory,
): Promise<AsrResult> {
  const adapter = call.model.adapter;
  const path =
    adapter?.submit_path ?? '/api/v3/plan/sauc/bigmodel_async';
  const url = toWsUrl(call.model.baseUrl, path);
  const nonstream =
    /nostream/.test(path) || adapter?.['nonstream'] === true;

  let audioCfg: AsrAudioConfig;
  let pcm: Buffer;
  if (call.rawPcm) {
    pcm = Buffer.from(call.audio);
    audioCfg = { format: 'raw', codec: 'raw', rate: 16000, bits: 16, channel: 1 };
  } else {
    const wav = parseWav(call.audio);
    pcm = wav.pcm;
    audioCfg = {
      format: 'wav',
      codec: 'raw',
      rate: wav.rate,
      bits: wav.bits,
      channel: wav.channels,
    };
  }

  const requestId = randomUUID();
  const handshakeHeaders: Record<string, string> = {
    'X-Api-Key': call.model.apiKey,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': requestId,
    'X-Api-Sequence': '-1',
  };
  if (adapter?.resource_id) {
    handshakeHeaders['X-Api-Resource-Id'] = adapter.resource_id;
  }

  const requestSection: Record<string, unknown> = {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    show_utterances: true,
    enable_nonstream: nonstream,
    // Adapter body and per-call overrides win over the defaults.
    ...((adapter?.create_body as Record<string, unknown> | undefined) ?? {}),
    ...(call.request ?? {}),
  };

  return await new Promise<AsrResult>((resolve, reject) => {
    const socket = socketFactory(url, handshakeHeaders);
    const frames: ParsedAsrFrame[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(new AsrError('ASR timed out waiting for final result'));
    }, call.timeoutMs ?? 60_000);

    const finish = (err: Error | null, result?: AsrResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // closing a dead socket is fine
      }
      if (err) reject(err);
      else resolve(result!);
    };

    if (call.signal) {
      if (call.signal.aborted) {
        finish(new AsrError('ASR aborted'));
        return;
      }
      call.signal.addEventListener(
        'abort',
        () => finish(new AsrError('ASR aborted')),
        { once: true },
      );
    }

    socket.onError((err) => finish(err));
    socket.onClose(() => {
      // Server closed without an explicit last package: return what arrived.
      if (!settled) finish(null, collect(frames));
    });
    socket.onMessage((data) => {
      const frame = parseFrame(data);
      frames.push(frame);
      if (frame.messageType === MESSAGE_TYPE.SERVER_ERROR_RESPONSE) {
        finish(
          new AsrError(
            `ASR server error (code ${frame.code ?? 'unknown'})`,
            frame.code ?? undefined,
          ),
        );
        return;
      }
      if (frame.isLastPackage) finish(null, collect(frames));
    });

    socket.onOpen(() => {
      // Frame 1: full request (seq 1).
      socket.send(
        buildFullRequest(1, {
          uid: call.uid ?? 'model-kit',
          audio: audioCfg,
          request: requestSection,
        }),
      );

      const bytesPerMs =
        (audioCfg.rate * (audioCfg.bits / 8) * audioCfg.channel) / 1000;
      const chunkBytes = Math.max(
        1,
        Math.floor(bytesPerMs * (call.chunkMs ?? 200)),
      );

      // Frames 2..N: audio chunks, seq starting at 2.
      let seq = 2;
      let offset = 0;
      if (pcm.length === 0) {
        socket.send(buildAudioOnly(seq, Buffer.alloc(0), true));
        return;
      }
      while (offset < pcm.length) {
        const end = Math.min(offset + chunkBytes, pcm.length);
        const isLast = end === pcm.length;
        socket.send(buildAudioOnly(seq, pcm.subarray(offset, end), isLast));
        offset = end;
        seq += 1;
      }
    });
  });
}
