import { describe, expect, it } from 'vitest';
import { completeJson, type ChatMessage } from '../src/driver.js';
import type { ResolvedModel } from '../src/types.js';

const base: ResolvedModel = {
  assignmentId: 'asg_vlm',
  alias: 'vision',
  role: 'primary',
  modalities: ['text', 'image'],
  model: 'vlm-test',
  litellmId: null,
  displayName: null,
  protocol: 'openai-compatible',
  baseUrl: 'https://provider.test/api/v3',
  apiKey: 'legacy-key',
  endpoints: { chat: '/chat/completions' },
  adapter: null,
  contextWindow: null,
  supportsJson: true,
  supportsStream: true,
  dailyBudgetMicros: null,
  pricing: null,
  source: 'hub',
};

function recordingFetch() {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({
        id: 'c1',
        choices: [{ message: { role: 'assistant', content: 'seen' } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe('multimodal chat content', () => {
  it('passes structured image_url content parts through verbatim', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '描述这个商品' },
          { type: 'image_url', image_url: { url: 'https://cdn.example/p.jpg', detail: 'high' } },
        ],
      },
    ];
    const result = await completeJson({ model: base, messages }, fetchImpl);
    expect(result.content).toBe('seen');
    const sent = bodies[0] as { messages: ChatMessage[] };
    expect(sent.messages[0]?.content).toEqual(messages[0]?.content);
    expect(sent.messages[0]?.content).toHaveLength(2);
  });

  it('keeps a plain string message unchanged (backward compatibility)', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    await completeJson({ model: base, messages: [{ role: 'user', content: 'hello' }] }, fetchImpl);
    const sent = bodies[0] as { messages: ChatMessage[] };
    expect(sent.messages[0]?.content).toBe('hello');
    expect(typeof sent.messages[0]?.content).toBe('string');
  });

  it('mixes text-only and multimodal messages in one call', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是选品助手' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://cdn.example/a.png' } }],
      },
    ];
    await completeJson({ model: base, messages }, fetchImpl);
    const sent = bodies[0] as { messages: ChatMessage[] };
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0]?.content).toBe('你是选品助手');
    expect(Array.isArray(sent.messages[1]?.content)).toBe(true);
  });
});
