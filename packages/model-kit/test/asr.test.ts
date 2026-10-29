import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildAudioOnly,
  buildFullRequest,
  nodeWsFactory,
  parseFrame,
  parseWav,
  transcribe,
} from '../src/asr.js';
import type {
  AsrSocket,
  AsrSocketFactory,
} from '../src/asr.js';
import type { ResolvedModel } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function model(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    assignmentId: 'asn',
    alias: 'asr',
    role: 'primary',
    modalities: ['audio'],
    model: 'doubao-seed-asr-2.0',
    litellmId: null,
    displayName: null,
    protocol: 'openai-compatible',
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'plan-key',
    endpoints: {},
    adapter: {
      submit_path: '/api/v3/plan/sauc/bigmodel_async',
      resource_id: 'volc.seedasr.sauc.duration',
    },
    contextWindow: null,
    supportsJson: false,
    supportsStream: false,
    dailyBudgetMicros: null,
    pricing: null,
    source: 'hub',
    ...overrides,
  };
}

function makeWav(seconds: number, rate = 16000): Buffer {
  const samples = seconds * rate;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// Build a server frame (message type 9 = full response) for tests.
function serverResponse(
  payload: object,
  opts: { flags?: number; seq?: number; messageType?: number } = {},
): Buffer {
  const flags = opts.flags ?? 0x1;
  const messageType = opts.messageType ?? 0x9;
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
  const head = Buffer.alloc(4);
  head[0] = (0x1 << 4) | 0x1;
  head[1] = (messageType << 4) | flags;
  head[2] = (0x1 << 4) | 0x1;
  head[3] = 0;
  const parts: Buffer[] = [head];
  if (flags & 0x1) {
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(opts.seq ?? 1, 0);
    parts.push(seqBuf);
  }
  if (messageType === 0x9) {
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(compressed.length, 0);
    parts.push(sizeBuf);
  } else if (messageType === 0xf) {
    const codeBuf = Buffer.alloc(4);
    codeBuf.writeInt32BE(400, 0);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(compressed.length, 0);
    parts.push(codeBuf, sizeBuf);
  }
  parts.push(compressed);
  return Buffer.concat(parts);
}

// Fake socket factory: lets the test script server behavior per sent frame.
function fakeFactory(
  onFrame: (
    frame: Buffer,
    respond: (data: Uint8Array) => void,
    close: () => void,
  ) => void,
): AsrSocketFactory {
  return () => {
    let openCb: () => void = () => {};
    let msgCb: (d: Uint8Array) => void = () => {};
    let closeCb: (c: number, r: string) => void = () => {};
    const socket: AsrSocket = {
      send: (frame) =>
        onFrame(
          Buffer.from(frame),
          (data) => msgCb(data),
          () => closeCb(1000, 'done'),
        ),
      close: () => closeCb(1000, 'closed'),
      onOpen: (cb) => {
        openCb = cb;
      },
      onMessage: (cb) => {
        msgCb = cb;
      },
      onError: () => {},
      onClose: (cb) => {
        closeCb = cb;
      },
    };
    queueMicrotask(() => openCb());
    return socket;
  };
}

// Decode the request section of a full-request frame (type 1) by reusing the
// server-frame parser, which applies the same gzip/JSON layout.
function decodeFullRequest(frame: Buffer): {
  user: { uid: string };
  audio: Record<string, unknown>;
  request: Record<string, unknown>;
} {
  const size = frame.readUInt32BE(8);
  const head = Buffer.alloc(4);
  head[0] = 0x11;
  head[1] = 0x90; // server full response, no sequence
  head[2] = 0x11;
  head[3] = 0;
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(size, 0);
  const parsed = parseFrame(
    Buffer.concat([head, sizeBuf, frame.subarray(12, 12 + size)]),
  );
  return parsed.payload as {
    user: { uid: string };
    audio: Record<string, unknown>;
    request: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Frame codec tests
// ---------------------------------------------------------------------------

describe('asr frame codec', () => {
  it('builds the full request with seq 1 and gzip JSON payload', () => {
    const frame = buildFullRequest(1, {
      uid: 'u1',
      audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel', enable_punc: true },
    });
    expect(frame[0]).toBe(0x11);
    expect(frame[1]).toBe(0x11); // type 1, flags 1
    expect(frame[2]).toBe(0x11); // json + gzip
    expect(frame.readInt32BE(4)).toBe(1);

    const size = frame.readUInt32BE(8);
    const payload = JSON.parse(
      gunzipSync(frame.subarray(12, 12 + size)).toString('utf8'),
    ) as {
      user: { uid: string };
      audio: { rate: number };
      request: { model_name: string; enable_punc: boolean };
    };
    expect(payload.user.uid).toBe('u1');
    expect(payload.audio.rate).toBe(16000);
    expect(payload.request.model_name).toBe('bigmodel');
    expect(payload.request.enable_punc).toBe(true);
  });

  it('marks the last audio chunk with negative sequence and flags 0x3', () => {
    const normal = buildAudioOnly(2, Buffer.from('abc'), false);
    expect(normal[1]).toBe(0x21); // type 2, flags 1
    expect(normal.readInt32BE(4)).toBe(2);

    const last = buildAudioOnly(5, Buffer.from('xyz'), true);
    expect(last[1]).toBe(0x23); // type 2, flags 3
    expect(last.readInt32BE(4)).toBe(-5);
  });

  it('parses a server response frame', () => {
    const frame = serverResponse(
      { result: { text: '你好世界', utterances: [{ text: '你好世界' }] } },
      { flags: 0x3, seq: 3 },
    );
    const parsed = parseFrame(frame);
    expect(parsed.messageType).toBe(0x9);
    expect(parsed.sequence).toBe(3);
    expect(parsed.isLastPackage).toBe(true);
    const payload = parsed.payload as {
      result: { text: string; utterances: Array<{ text: string }> };
    };
    expect(payload.result.text).toBe('你好世界');
    expect(payload.result.utterances[0]!.text).toBe('你好世界');
  });
});

// ---------------------------------------------------------------------------
// WAV parsing
// ---------------------------------------------------------------------------

describe('wav parsing', () => {
  it('extracts PCM and audio metadata', () => {
    const wav = makeWav(1);
    const data = parseWav(wav);
    expect(data.rate).toBe(16000);
    expect(data.bits).toBe(16);
    expect(data.channels).toBe(1);
    expect(data.pcm.length).toBe(16000 * 2);
  });

  it('throws on non-WAV input', () => {
    expect(() => parseWav(Buffer.from('not a wav file at all'))).toThrow(
      /invalid WAV/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end recognition
// ---------------------------------------------------------------------------

describe('transcribe flow', () => {
  it('streams audio and collects the final transcript', async () => {
    const sent: Buffer[] = [];
    const factory = fakeFactory((frame, respond, close) => {
      sent.push(frame);
      const messageType = frame[1]! >> 4;
      if (messageType === 0x2) {
        const flags = frame[1]! & 0x0f;
        if (flags === 0x3) {
          // Last packet: server returns the final result with last flag.
          respond(
            serverResponse(
              { result: { text: '你好世界', utterances: [{ text: '你好世界' }] } },
              { flags: 0x3, seq: 1 },
            ),
          );
        } else {
          respond(
            serverResponse(
              { result: { text: '你好', utterances: [{ text: '你好' }] } },
              { flags: 0x1, seq: 1 },
            ),
          );
        }
      }
      void close;
    });

    const result = await transcribe(
      { model: model(), audio: makeWav(0.5), chunkMs: 100 },
      factory,
    );

    expect(result.text).toBe('你好世界');
    expect(result.utterances.length).toBeGreaterThan(0);
    // First frame is the full request (type 1); audio frames follow.
    expect(sent[0]![1]! >> 4).toBe(0x1);
    expect(sent.length).toBeGreaterThan(1);
  });

  it('rejects on a server error frame', async () => {
    const factory = fakeFactory((frame, respond) => {
      if ((frame[1]! >> 4) === 0x2) {
        respond(
          serverResponse({ message: 'bad request' }, { messageType: 0xf }),
        );
      }
    });
    await expect(
      transcribe({ model: model(), audio: makeWav(0.2) }, factory),
    ).rejects.toThrow(/ASR server error/);
  });

  it('sets enable_nonstream for the nostream endpoint', async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    const factory = fakeFactory((frame, respond) => {
      if ((frame[1]! >> 4) === 0x1) {
        capturedRequest = decodeFullRequest(frame).request;
        respond(
          serverResponse({ result: { text: '完整结果' } }, { flags: 0x3 }),
        );
      }
    });

    const result = await transcribe(
      {
        model: model({
          adapter: {
            submit_path: '/api/v3/plan/sauc/bigmodel_nostream',
            resource_id: 'volc.seedasr.sauc.duration',
          },
        }),
        audio: makeWav(0.2),
      },
      factory,
    );

    expect(result.text).toBe('完整结果');
    expect(capturedRequest!['enable_nonstream']).toBe(true);
  });
});

// nodeWsFactory against a real local ws server: handshake headers and binary
// frame exchange end to end.
describe('nodeWsFactory', () => {
  it('connects with handshake headers and exchanges binary frames', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.on('listening', resolve));
    const address = wss.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    let resolveHandshake: (h: Record<string, string>) => void = () => {};
    const serverHandshake = new Promise<Record<string, string>>(
      (resolve) => {
        resolveHandshake = resolve;
      },
    );
    wss.on('connection', (ws, req) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      ws.on('message', (data) => ws.send(data)); // echo
      resolveHandshake(headers);
    });

    const socket = nodeWsFactory(`ws://127.0.0.1:${port}`, {
      'X-Api-Key': 'k',
    });
    await new Promise<void>((resolve) => socket.onOpen(resolve));
    const handshake = await serverHandshake;
    expect(handshake['x-api-key']).toBe('k');

    const echoed = await new Promise<Uint8Array>((resolve) => {
      socket.onMessage((data) => resolve(data));
      socket.send(Buffer.from('hello'));
    });
    expect(Buffer.from(echoed).toString()).toBe('hello');

    socket.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Wire contract pinned by a real run against openspeech.bytedance.com
// (2026-10-29). The fake-socket tests above all passed while the live
// endpoint rejected the same traffic, so these lock down the three fields that
// only a real server exposed.
// ---------------------------------------------------------------------------

describe('asr wire contract (live-pinned)', () => {
  async function runCaptured(
    adapter: Record<string, unknown>,
    audio: Buffer,
  ): Promise<{ sent: Buffer[]; text: string }> {
    const sent: Buffer[] = [];
    const factory = fakeFactory((frame, respond) => {
      sent.push(frame);
      // The last audio frame carries NEG_WITH_SEQUENCE (0x3).
      if ((frame[1]! & 0x0f) === 0x3) {
        respond(
          new Uint8Array(serverResponse({ result: { text: '你好' } }, { flags: 0x3 })),
        );
      }
    });
    const result = await transcribe(
      {
        model: model({ adapter: adapter as ResolvedModel['adapter'] }),
        audio: new Uint8Array(audio),
      },
      factory,
    );
    return { sent, text: result.text };
  }

  const adapter = {
    submit_path: '/api/v3/plan/sauc/bigmodel_async',
    resource_id: 'volc.seedasr.sauc.duration',
  };

  it('tags audio-only frames as raw while the full request stays JSON', async () => {
    const { sent } = await runCaptured(adapter, makeWav(1));
    // Byte 2 = serialization (high nibble) + compression (low nibble).
    expect(sent[0]![2]).toBe(0x11); // request: JSON + gzip
    expect(sent.slice(1).every((f) => f[2] === 0x01)).toBe(true); // audio: raw + gzip
  });

  it('declares pcm, because only the WAV body is uploaded', async () => {
    const { sent, text } = await runCaptured(adapter, makeWav(1));
    const req = decodeFullRequest(sent[0]!);
    expect(text).toBe('你好');
    // Declaring the container format made the server answer 45000151.
    expect(req.audio).toMatchObject({
      format: 'pcm',
      rate: 16000,
      bits: 16,
      channel: 1,
    });
  });

  it('always asks for the final non-stream result', async () => {
    for (const submitPath of [
      '/api/v3/plan/sauc/bigmodel_async',
      '/api/v3/plan/sauc/bigmodel_nostream',
    ]) {
      const { sent } = await runCaptured({ ...adapter, submit_path: submitPath }, makeWav(1));
      expect(decodeFullRequest(sent[0]!).request.enable_nonstream).toBe(true);
    }
  });

  it('prefers the last non-empty text when the final frame is empty', async () => {
    const frames = [
      { result: { text: '你好' } },
      { result: { additions: { log_id: 'x' } } },
      { result: { text: '' } },
    ];
    const factory = fakeFactory((frame, respond) => {
      const isLast = (frame[1]! & 0x0f) === 0x3;
      if (!isLast) return;
      respond(new Uint8Array(serverResponse(frames[0]!, { flags: 0x1 })));
      respond(new Uint8Array(serverResponse(frames[1]!, { flags: 0x1 })));
      respond(new Uint8Array(serverResponse(frames[2]!, { flags: 0x3 })));
    });
    const result = await transcribe(
      { model: model({ adapter: adapter as ResolvedModel['adapter'] }), audio: new Uint8Array(makeWav(1)) },
      factory,
    );
    expect(result.text).toBe('你好');
  });
});
