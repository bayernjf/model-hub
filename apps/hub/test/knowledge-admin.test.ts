import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';
import type { KnowledgePorts } from '../src/knowledge/service.js';
import type { Hono } from 'hono';

// Scripted vectors so ingest/query behave deterministically; no real hub.
function scriptedPorts(): KnowledgePorts {
  return {
    embed: async (inputs) => inputs.map((t) => [t.length, 1]),
    rerank: async (_q, contents) => contents.map((_, i) => contents.length - i),
    answer: async (_q, contexts) => `answer from ${contexts.length} passages`,
  };
}

interface Setup {
  app: Hono;
  ownerCookie: string;
  operatorCookie: string;
  projectId: string;
}

async function setup(): Promise<Setup> {
  const t = makeTestApp({}, { knowledgePorts: async () => scriptedPorts() });
  const ownerCookie = await login(t.app);
  const opRes = await t.app.request('/api/admin/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'operator-password-123' }),
  });
  const operatorCookie = opRes.headers.get('Set-Cookie')?.split(';')[0] ?? '';

  const prjRes = await t.app.request('/api/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ slug: 'loom', display_name: 'Loom' }),
  });
  const project = (await prjRes.json()) as { project: { id: string } };
  return {
    app: t.app,
    ownerCookie,
    operatorCookie,
    projectId: project.project.id,
  };
}

describe('admin knowledge routes', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('requires an admin session', async () => {
    const res = await s.app.request(
      `/api/admin/knowledge/documents?owner=${s.projectId}`,
    );
    expect(res.status).toBe(401);
  });

  it('404s for an unknown owner project', async () => {
    const res = await s.app.request(
      '/api/admin/knowledge/documents?owner=prj_missing',
      { headers: { Cookie: s.ownerCookie } },
    );
    expect(res.status).toBe(404);
  });

  it('ingests, lists, queries and deletes for a chosen owner', async () => {
    const ingest = await s.app.request('/api/admin/knowledge/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.ownerCookie },
      body: JSON.stringify({
        owner: s.projectId,
        title: 'Policies',
        text: 'refund within thirty days',
        mime: 'text/markdown',
      }),
    });
    expect(ingest.status).toBe(201);
    const created = (await ingest.json()) as {
      document: { id: string; source: string };
      chunk_count: number;
    };
    expect(created.document.source).toBe('console');

    // A second document so the reranker has more than one candidate.
    const second = await s.app.request('/api/admin/knowledge/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.ownerCookie },
      body: JSON.stringify({
        owner: s.projectId,
        title: 'Shipping',
        text: 'packages arrive in five days',
      }),
    });
    expect(second.status).toBe(201);

    const list = await s.app.request(
      `/api/admin/knowledge/documents?owner=${s.projectId}`,
      { headers: { Cookie: s.ownerCookie } },
    );
    const docs = (await list.json()) as {
      documents: Array<{ id: string; title: string; chunk_count: number }>;
    };
    expect(docs.documents).toHaveLength(2);
    expect(docs.documents.map((d) => d.title).sort()).toEqual([
      'Policies',
      'Shipping',
    ]);

    const query = await s.app.request('/api/admin/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.ownerCookie },
      body: JSON.stringify({ owner: s.projectId, query: 'refund window' }),
    });
    expect(query.status).toBe(200);
    const outcome = (await query.json()) as {
      answer: string | null;
      citations: Array<{ title: string }>;
      reranked: boolean;
    };
    expect(outcome.answer).toBe('answer from 2 passages');
    expect(outcome.reranked).toBe(true);
    expect(outcome.citations[0]?.title).toBe('Policies');

    const del = await s.app.request(
      `/api/admin/knowledge/documents/${created.document.id}?owner=${s.projectId}`,
      { method: 'DELETE', headers: { Cookie: s.ownerCookie } },
    );
    expect(del.status).toBe(200);
    expect((await del.json()) as { deleted: boolean }).toEqual({ deleted: true });
  });

  it('rejects pdf uploads with a clear unsupported error', async () => {
    const res = await s.app.request('/api/admin/knowledge/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.ownerCookie },
      body: JSON.stringify({
        owner: s.projectId,
        title: 'handbook.pdf',
        text: 'irrelevant',
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_media_type');
  });

  it('allows the operator to read but not to write', async () => {
    const list = await s.app.request(
      `/api/admin/knowledge/documents?owner=${s.projectId}`,
      { headers: { Cookie: s.operatorCookie } },
    );
    expect(list.status).toBe(200);

    const query = await s.app.request('/api/admin/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.operatorCookie },
      body: JSON.stringify({ owner: s.projectId, query: 'anything' }),
    });
    expect(query.status).toBe(200);

    const ingest = await s.app.request('/api/admin/knowledge/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.operatorCookie },
      body: JSON.stringify({ owner: s.projectId, title: 'T', text: 'body' }),
    });
    expect(ingest.status).toBe(403);

    const del = await s.app.request(
      `/api/admin/knowledge/documents/doc_x?owner=${s.projectId}`,
      { method: 'DELETE', headers: { Cookie: s.operatorCookie } },
    );
    expect(del.status).toBe(403);
  });
});
