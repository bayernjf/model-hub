import { describe, it, expect } from 'vitest';
import { embedJson, generateImage, generateVideo } from '../src/media.js';
import type { ResolvedModel } from '../src/types.js';

function model(overrides: Partial<ResolvedModel>): ResolvedModel {
  return {
    assignmentId: 'asn',
    alias: 'm',
    role: 'primary',
    modalities: ['text'],
    model: 'test-model',
    litellmId: null,
    displayName: null,
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
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

describe('embed driver', () => {
  it('embeds text into vectors', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200 },
      )) as typeof fetch;
    const result = await embedJson(
      {
        model: model({ endpoints: { embeddings: '/embeddings' } }),
        input: 'hello',
      },
      fake,
    );
    expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.httpStatus).toBe(200);
    // Responses without a usage block still succeed, with null usage.
    expect(result.usage).toBeNull();
  });

  it('surfaces the echoed usage block for cost reporting', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
          usage: { prompt_tokens: 42, total_tokens: 42 },
        }),
        { status: 200 },
      )) as typeof fetch;
    const result = await embedJson(
      {
        model: model({ modalities: ['embedding'] }),
        input: ['refund policy', 'shipping policy'],
      },
      fake,
    );
    expect(result.usage).toEqual({ prompt_tokens: 42, total_tokens: 42 });
  });

  it('treats a malformed usage block as absent', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [1] }],
          usage: { prompt_tokens: 'many' },
        }),
        { status: 200 },
      )) as typeof fetch;
    const result = await embedJson(
      { model: model({ modalities: ['embedding'] }), input: 'hi' },
      fake,
    );
    expect(result.usage).toBeNull();
  });
});

describe('image driver', () => {
  it('generates an image and returns the url', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ data: [{ url: 'https://img.example/x.png' }] }),
        { status: 200 },
      )) as typeof fetch;
    const result = await generateImage(
      {
        model: model({ endpoints: { images: '/images/generations' } }),
        prompt: 'a cat',
      },
      fake,
    );
    expect(result.url).toBe('https://img.example/x.png');
  });
});

describe('video driver', () => {
  it('submits a video and polls to completion using the adapter dialect', async () => {
    let polls = 0;
    let submitBody: string | null = null;
    const fake = (async (_input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        submitBody = String(init?.body);
        return new Response(
          JSON.stringify({ id: 'job1', video_id: 'job1' }),
          { status: 200 },
        );
      }
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({ status: 'processing' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ status: 'completed', url: 'https://video.example/v.mp4' }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await generateVideo(
      {
        model: model({
          endpoints: { videos: '/videos' },
          adapter: {
            submit_path: '/videos',
            retrieval_url_template: '/agnesapi?video_id={jobId}&model_name={model}',
            result_url_path: 'url',
            create_body: { size: '720P', mode: 'text' },
            seconds_field: 'seconds',
            seconds_range: [4, 12],
            poll_interval_ms: 1,
          },
        }),
        prompt: 'a cat',
        pollTimeoutMs: 5000,
      },
      fake,
    );

    expect(result.jobId).toBe('job1');
    expect(result.url).toBe('https://video.example/v.mp4');
    // The submit body must use the dialect (seconds + mode + size), not `duration`.
    expect(submitBody).toContain('"mode":"text"');
    expect(submitBody).toContain('"seconds":"5"');
    expect(submitBody).not.toContain('"duration"');
  });

  it('returns submit-only when no poll template is configured', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ id: 'job2' }), { status: 200 })) as typeof fetch;
    const result = await generateVideo(
      { model: model({ endpoints: { videos: '/videos' } }), prompt: 'a cat' },
      fake,
    );
    expect(result.jobId).toBe('job2');
    expect(result.url).toBeNull();
  });
});
