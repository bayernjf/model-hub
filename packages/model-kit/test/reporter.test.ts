import { describe, expect, it } from 'vitest';
import { postUsage, reportUsageInBackground, type UsageInput } from '../src/reporter.js';

// D-7 / D2-4: a usage report is fire-and-forget and never throws into the
// caller, but its failures must be observable. `onError` is the observation
// hook — absent, the old silent swallow stays byte-identical.

const INPUT = {
  project: 'zeus',
  feature: 'decision:score',
  billingSource: 'builtin',
  model: { model: 'test-model' },
  httpStatus: 200,
} as unknown as UsageInput;

function fetchWith(impl: () => Promise<Response>): typeof fetch {
  return (async () => impl()) as unknown as typeof fetch;
}

describe('usage report failure observer (D2-4)', () => {
  it('reports a non-2xx response through onError', async () => {
    const seen: string[] = [];
    await postUsage('https://hub.local', 'tok', fetchWith(async () => new Response('', { status: 503 }), ), INPUT, reason => seen.push(reason));
    expect(seen).toEqual(['usage report failed: HTTP 503']);
  });

  it('reports a network error through onError and still never rejects', async () => {
    const seen: string[] = [];
    await expect(postUsage(
      'https://hub.local',
      'tok',
      fetchWith(async () => { throw new Error('ECONNREFUSED'); }),
      INPUT,
      reason => seen.push(reason),
    )).resolves.toBeUndefined();
    expect(seen).toEqual(['ECONNREFUSED']);
  });

  it('stays silent when no observer is configured', async () => {
    await expect(postUsage('https://hub.local', 'tok', fetchWith(async () => new Response('', { status: 500 })), INPUT))
      .resolves.toBeUndefined();
  });

  it('forwards the observer from the background reporter', async () => {
    const seen: string[] = [];
    await reportUsageInBackground(
      'https://hub.local',
      'tok',
      fetchWith(async () => new Response('', { status: 429 })),
      INPUT,
      reason => seen.push(reason),
    );
    expect(seen).toEqual(['usage report failed: HTTP 429']);
  });
});
