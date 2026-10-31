import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeTestApp, login } from './helpers.js';

// W5-3 budget watermark alerts: crossing 80%/100% of an assignment's daily
// budget fires an HMAC-signed webhook at most once per assignment per UTC
// day per level; without a configured URL the whole layer is skipped.

const WEBHOOK_URL = 'https://ops.local/hooks/model-hub-budget';
const WEBHOOK_SECRET = 'alert-shared-secret';

interface CapturedWebhook {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function setup(opts?: {
  withoutWebhookUrl?: boolean;
  webhookStatus?: number;
  webhookThrow?: boolean;
}) {
  const webhookCalls: CapturedWebhook[] = [];
  const fetchImpl = (async (input, init) => {
    webhookCalls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    if (opts?.webhookThrow) throw new Error('connection refused');
    return new Response(JSON.stringify({ ok: false }), {
      status: opts?.webhookStatus ?? 200,
    });
  }) as typeof fetch;

  const env: Record<string, string> = {};
  if (!opts?.withoutWebhookUrl) {
    env.HUB_BUDGET_WEBHOOK_URL = WEBHOOK_URL;
    env.HUB_BUDGET_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }
  const t = makeTestApp(env, { budgetAlertFetch: fetchImpl });
  const cookie = await login(t.app);

  const provRes = await t.app.request('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name: 'Ark',
      preset_id: 'ark',
      protocol: 'openai-compatible',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'vendor-secret-key',
    }),
  });
  const provider = (await provRes.json()) as { provider: { id: string } };

  const importRes = await t.app.request(
    `/api/admin/providers/${provider.provider.id}/models/import`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        preset_provider_id: 'ark',
        model_ids: ['doubao-seed-1-6'],
      }),
    },
  );
  const imported = (await importRes.json()) as {
    imported: Array<{ id: string }>;
  };
  const modelId = imported.imported[0]?.id ?? '';

  await t.app.request(`/api/admin/models/${modelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ enabled: true }),
  });

  const prjRes = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug: 'zeus', display_name: 'Zeus' }),
  });
  const project = (await prjRes.json()) as { project: { id: string } };

  const tokRes = await t.app.request(
    `/api/admin/projects/${project.project.id}/rotate-token`,
    { method: 'POST', headers: { Cookie: cookie } },
  );
  const token = (await tokRes.json()) as { token: string };

  // Budget 100000 micros; doubao-seed-1-6 costs input_tokens * 0.12 micros.
  const asnRes = await t.app.request('/api/admin/assignments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      project_id: project.project.id,
      assignments: [
        {
          model_id: modelId,
          alias: 'noul',
          role: 'primary',
          daily_budget_micros: 100_000,
        },
      ],
    }),
  });
  const assignmentId = (
    (await asnRes.json()) as { assignments: Array<{ id: string }> }
  ).assignments[0]?.id ?? '';

  return { t, token: token.token, assignmentId, webhookCalls };
}

describe('budget watermark alerts', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  async function report(inputTokens: number, overrides: Record<string, unknown> = {}) {
    return s.t.app.request('/pub/v1/usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify({
        project: 'zeus',
        feature: 'noul',
        billing_source: 'builtin',
        provider: 'ark',
        model: 'doubao-seed-1-6-250615',
        assignment_id: s.assignmentId,
        input_tokens: inputTokens,
        output_tokens: 0,
        http_status: 200,
        cached: false,
        ts: new Date().toISOString(),
        ...overrides,
      }),
    });
  }

  function levels(): Array<number> {
    return s.webhookCalls.map((c) => (JSON.parse(c.body) as { level: number }).level);
  }

  it('stays silent below the 80% watermark', async () => {
    // 200000 * 0.12 = 24000 micros = 24% of budget.
    const res = await report(200_000);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(s.webhookCalls).toHaveLength(0));
  });

  it('fires 80% once per day even as spend keeps growing', async () => {
    // 24% -> 84% (80000 crossing) -> 96%: a single level-80 alert.
    await report(200_000);
    await report(500_000); // +60000 = 84000 (84%)
    await report(100_000); // +12000 = 96000 (96%)

    await vi.waitFor(() => expect(s.webhookCalls).toHaveLength(1));
    expect(levels()).toEqual([80]);
  });

  it('fires 100% when spend reaches the budget, after the 80% alert', async () => {
    await report(200_000); // 24%
    await report(500_000); // 84%
    await report(100_000); // 96%
    await report(400_000); // +48000 = 144000 (144%)

    await vi.waitFor(() => expect(s.webhookCalls).toHaveLength(2));
    expect(levels()).toEqual([80, 100]);
  });

  it('fires both levels at once when spend jumps straight past 100%', async () => {
    // 1000000 * 0.12 = 120000 micros = 120% of budget in one report.
    await report(1_000_000);

    await vi.waitFor(() => expect(s.webhookCalls).toHaveLength(2));
    expect(levels()).toEqual([80, 100]);
  });

  it('signs the webhook body and stamps a delivery id', async () => {
    await report(1_000_000);
    await vi.waitFor(() => expect(s.webhookCalls).toHaveLength(2));

    const first = s.webhookCalls[0] as CapturedWebhook;
    expect(first.url).toBe(WEBHOOK_URL);
    expect(first.headers['x-hub-event']).toBe('budget.threshold');
    expect(first.headers['x-hub-delivery-id']).toMatch(/^bal_/);
    expect(first.headers['x-hub-signature']).toBe(
      `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(first.body, 'utf8').digest('hex')}`,
    );

    const payload = JSON.parse(first.body) as Record<string, unknown>;
    expect(payload['type']).toBe('budget.threshold');
    expect(payload['project']).toBe('zeus');
    expect(payload['assignment_id']).toBe(s.assignmentId);
    expect(payload['alias']).toBe('noul');
    expect(payload['model']).toBe('doubao-seed-1-6-250615');
    expect(payload['day']).toBe(new Date().toISOString().slice(0, 10));
    expect(payload['spent_micros']).toBe(120_000);
    expect(payload['budget_micros']).toBe(100_000);
    expect(payload['percent']).toBe(120);
    expect(typeof payload['at']).toBe('string');
  });

  it('skips the whole alert layer without a configured URL', async () => {
    const quiet = await setup({ withoutWebhookUrl: true });
    const res = await quiet.t.app.request('/pub/v1/usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${quiet.token}`,
      },
      body: JSON.stringify({
        project: 'zeus',
        feature: 'noul',
        billing_source: 'builtin',
        provider: 'ark',
        model: 'doubao-seed-1-6-250615',
        assignment_id: quiet.assignmentId,
        input_tokens: 1_000_000,
        output_tokens: 0,
        http_status: 200,
        cached: false,
        ts: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(quiet.webhookCalls).toHaveLength(0));
  });

  it('never alerts on byok reports (no owner cost)', async () => {
    await report(1_000_000, { billing_source: 'byok' });
    await vi.waitFor(() => expect(s.webhookCalls).toHaveLength(0));
  });

  it('keeps the usage report healthy when the webhook endpoint fails', async () => {
    for (const webhookOpts of [
      { webhookStatus: 500 },
      { webhookThrow: true },
    ]) {
      const failing = await setup(webhookOpts);
      const res = await failing.t.app.request('/pub/v1/usage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${failing.token}`,
        },
        body: JSON.stringify({
          project: 'zeus',
          feature: 'noul',
          billing_source: 'builtin',
          provider: 'ark',
          model: 'doubao-seed-1-6-250615',
          assignment_id: failing.assignmentId,
          input_tokens: 1_000_000,
          output_tokens: 0,
          http_status: 200,
          cached: false,
          ts: new Date().toISOString(),
        }),
      });
      const data = (await res.json()) as { accepted: boolean };
      expect(res.status).toBe(200);
      expect(data.accepted).toBe(true);
      await vi.waitFor(() => expect(failing.webhookCalls).toHaveLength(2));
    }
  });
});
