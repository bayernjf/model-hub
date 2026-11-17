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

describe('org usage dimensions (Tier0 M3 F3.1)', () => {
  function capture(): { bodies: unknown[]; fetchImpl: typeof fetch } {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  it('sends the three org dimensions when provided', async () => {
    const { bodies, fetchImpl } = capture();
    await postUsage('https://hub.local', 'tok', fetchImpl, {
      ...INPUT,
      usageDimensions: {
        position_id: 'pos_01',
        department_id: 'dep_01',
        task_id: 'task_01',
      },
    } as UsageInput);
    expect(bodies[0]).toMatchObject({
      position_id: 'pos_01',
      department_id: 'dep_01',
      task_id: 'task_01',
    });
  });

  it('omits every org dimension when the caller has no org context', async () => {
    const { bodies, fetchImpl } = capture();
    await postUsage('https://hub.local', 'tok', fetchImpl, INPUT);
    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('position_id');
    expect(body).not.toHaveProperty('department_id');
    expect(body).not.toHaveProperty('task_id');
  });

  it('sends only the dimensions that are present', async () => {
    const { bodies, fetchImpl } = capture();
    await postUsage('https://hub.local', 'tok', fetchImpl, {
      ...INPUT,
      usageDimensions: { task_id: 'task_only' },
    } as UsageInput);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.task_id).toBe('task_only');
    expect(body).not.toHaveProperty('position_id');
    expect(body).not.toHaveProperty('department_id');
  });
});
