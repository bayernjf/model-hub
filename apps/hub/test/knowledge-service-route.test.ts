import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, login, type TestApp } from './helpers.js';
import type { KnowledgePorts } from '../src/knowledge/service.js';

// Regression for a route-mount bug: the project-facing knowledge API was
// mounted at '/', so its real paths were '/v1/knowledge/*'. The server entry
// only forwards /api/ and /pub/ to Hono (backend-routes.ts), so those calls
// either 302-redirected to the login page (via Astro) or 404'd when clients
// used the documented /api/v1/knowledge/* path. The mount is now '/api',
// matching docs/knowledge-api.md and the loom client.
function scriptedPorts(): KnowledgePorts {
  return {
    embed: async (inputs) => inputs.map((t) => [t.length, 1]),
    rerank: async (_q, contents) => contents.map((_, i) => contents.length - i),
    answer: async (_q, contexts) => `answer from ${contexts.length} passages`,
  };
}

describe('project-facing knowledge API contract', () => {
  let t: TestApp;
  let cookie: string;
  let projectId: string;
  let token: string;

  beforeEach(async () => {
    t = makeTestApp({}, { knowledgePorts: async () => scriptedPorts() });
    cookie = await login(t.app);
    const prj = await t.app.request('/api/admin/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ slug: 'loom', display_name: 'Loom' }),
    });
    projectId = ((await prj.json()) as { project: { id: string } }).project.id;
    const minted = await t.app.request(
      `/api/admin/projects/${projectId}/rotate-token`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    token = ((await minted.json()) as { token: string }).token;
  });

  it('serves the documented /api/v1/knowledge/query path with a project token', async () => {
    const ingest = await t.app.request('/api/admin/knowledge/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        owner: projectId,
        title: 'Policies',
        text: 'refund within thirty days of delivery',
        mime: 'text/markdown',
      }),
    });
    expect(ingest.status).toBe(201);

    const res = await t.app.request('/api/v1/knowledge/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: 'refund window', top_k: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { citations: unknown[] };
    expect(Array.isArray(body.citations)).toBe(true);
    expect(body.citations.length).toBeGreaterThan(0);
  });

  it('rejects project API calls without a bearer token', async () => {
    const res = await t.app.request('/api/v1/knowledge/documents', {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('does not expose the bare /v1 path (it must live under /api)', async () => {
    const res = await t.app.request('/v1/knowledge/documents', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
