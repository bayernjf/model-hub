import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { synthesize } from '../src/audio.js';
import type { ResolvedModel } from '../src/types.js';

function model(overrides: Partial<ResolvedModel>): ResolvedModel {
  return {
    assignmentId: 'asn',
    alias: 'm',
    role: 'primary',
    modalities: ['audio'],
    model: 'doubao-seed-tts-2.0',
    litellmId: null,
    displayName: null,
    protocol: 'openai-compatible',
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'key',
    endpoints: {},
    adapter: null,
    contextWindow: null,
    supportsJson: false,
    supportsStream: false,
    dailyBudgetMicros: null,
    pricing: null,
    source: 'hub',
    ...overrides,
  };
}

describe('tts driver', () => {
  it('synthesizes doubao voice via X-Api-Key and chunked JSON', async () => {
    const audioB64 = Buffer.from('fake-audio-bytes').toString('base64');
    let headers: Record<string, string> = {};
    let body: string | null = null;
    const fake = (async (_input, init) => {
      headers = (init?.headers as Record<string, string> | undefined) ?? {};
      body = String(init?.body);
      return new Response(`{"code":0,"data":"${audioB64}"}`, { status: 200 });
    }) as typeof fetch;

    const result = await synthesize(
      {
        model: model({
          adapter: {
            submit_path: '/api/v3/plan/tts/unidirectional',
            auth_style: 'x-api-key',
            resource_id: 'seed-tts-2.0',
            create_body: {
              speaker: 'zh_female_vv_uranus_bigtts',
              audio_params: { format: 'mp3', sample_rate: 24000 },
            },
          },
        }),
        text: '你好',
      },
      fake,
    );

    expect(headers['X-Api-Key']).toBe('key');
    expect(headers['X-Api-Resource-Id']).toBe('seed-tts-2.0');
    expect(headers['Authorization']).toBeUndefined();
    expect(body).toContain('"text":"你好"');
    expect(body).toContain('zh_female_vv_uranus_bigtts');
    expect(result.audio).not.toBeNull();
    expect(new TextDecoder().decode(result.audio!)).toBe('fake-audio-bytes');
  });
});
