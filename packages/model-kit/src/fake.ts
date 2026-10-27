export class FakeProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeProviderError';
  }
}

export interface FakeOptions {
  responseText?: string;
  model?: string;
}

// A fetch implementation that returns synthetic chat completions, for tests.
// Refuses to start when NODE_ENV is production.
export function createFakeFetch(options?: FakeOptions): typeof fetch {
  if (process.env.NODE_ENV === 'production') {
    throw new FakeProviderError(
      'fake/synthetic provider must not be enabled in production',
    );
  }

  const responseText = options?.responseText ?? 'synthetic response';

  return (async (_input, init) => {
    let body: { model?: string; stream?: boolean } = {};
    try {
      body = JSON.parse((init?.body as string) ?? '{}') as typeof body;
    } catch {
      // use defaults
    }
    const model = body.model ?? options?.model ?? 'fake-model';

    if (body.stream) {
      const encoder = new TextEncoder();
      const frames = [
        {
          id: 'fake-1',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: responseText } }],
        },
        {
          id: 'fake-1',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      ];
      const sse = frames
        .map((f) => `data: ${JSON.stringify(f)}\n\n`)
        .join('')
        .concat('data: [DONE]\n\n');
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sse));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'fake-1',
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: responseText },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}
