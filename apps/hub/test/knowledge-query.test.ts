import { describe, expect, it, beforeEach } from 'vitest';
import { makeTestApp, login } from './helpers.js';
import type { KnowledgePorts } from '../src/knowledge/service.js';
import type { Hono } from 'hono';

// Scripted embedding vectors keyed by text so queries can be reasoned about
// deterministically; no real provider or hub is contacted.
const VECTORS: Record<string, number[]> = {
  alpha: [1, 0],
  gamma: [0.9, 0.1],
  beta: [0, 1],
};

function scriptedPorts(overrides: Partial<KnowledgePorts> = {}): KnowledgePorts {
  return {
    embed: async (inputs) =>
      inputs.map((t) => VECTORS[t] ?? [0, 0]),
    ...overrides,
  };
}

interface Setup {
  app: Hono;
  tokenA: string;
  tokenB: string;
}

async function setup(
  ports: KnowledgePorts | null = scriptedPorts(),
): Promise<Setup> {
  const t = makeTestApp({}, { knowledgePorts: ports ? async () => ports : async () => null });
  const cookie = await login(t.app);

  const tokens: string[] = [];
  for (const slug of ['proj-a', 'proj-b']) {
    const prjRes = await t.app.request('/api/admin/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ slug, display_name: slug }),
    });
    const project = (await prjRes.json()) as { project: { id: string } };
    const tokRes = await t.app.request(
      `/api/admin/projects/${project.project.id}/rotate-token`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    const token = (await tokRes.json()) as { token: string };
    tokens.push(token.token);
  }
  return { app: t.app, tokenA: tokens[0] as string, tokenB: tokens[1] as string };
}

function bearer(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function ingest(
  app: Hono,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/v1/knowledge/ingest', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify(body),
  });
}

describe('knowledge routes auth', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('rejects missing and unknown tokens with 401', async () => {
    const noAuth = await s.app.request('/v1/knowledge/documents');
    expect(noAuth.status).toBe(401);

    const badAuth = await s.app.request('/v1/knowledge/documents', {
      headers: { Authorization: 'Bearer mh_not_a_token' },
    });
    expect(badAuth.status).toBe(401);

    const badIngest = await s.app.request('/v1/knowledge/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', text: 'x' }),
    });
    expect(badIngest.status).toBe(401);
  });
});

describe('knowledge ingest route', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('stores a document and lists it for its owner only', async () => {
    const res = await ingest(s.app, s.tokenA, {
      title: 'Policies',
      text: 'alpha',
      mime: 'text/markdown',
      source: 'console',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      document: { id: string; owner: string; source: string };
      chunk_count: number;
    };
    expect(created.chunk_count).toBe(1);
    expect(created.document.source).toBe('console');

    const listA = await s.app.request('/v1/knowledge/documents', {
      headers: bearer(s.tokenA),
    });
    const docsA = (await listA.json()) as {
      documents: Array<{ title: string; chunk_count: number }>;
    };
    expect(docsA.documents).toHaveLength(1);
    expect(docsA.documents[0]?.title).toBe('Policies');
    expect(docsA.documents[0]?.chunk_count).toBe(1);

    const listB = await s.app.request('/v1/knowledge/documents', {
      headers: bearer(s.tokenB),
    });
    const docsB = (await listB.json()) as { documents: unknown[] };
    expect(docsB.documents).toEqual([]);
  });

  it('validates the body and rejects unsupported formats', async () => {
    const missingText = await ingest(s.app, s.tokenA, { title: 'T' });
    expect(missingText.status).toBe(400);

    const badMime = await ingest(s.app, s.tokenA, {
      title: 'T',
      text: 'x',
      mime: 'application/pdf',
    });
    expect(badMime.status).toBe(400);

    const pdfTitle = await ingest(s.app, s.tokenA, {
      title: 'manual.pdf',
      text: 'x',
    });
    expect(pdfTitle.status).toBe(422);
    const pdfBody = (await pdfTitle.json()) as { error: { code: string } };
    expect(pdfBody.error.code).toBe('unsupported_media_type');

    const badChunk = await ingest(s.app, s.tokenA, {
      title: 'T',
      text: 'x',
      chunk_size: 100,
      chunk_overlap: 100,
    });
    expect(badChunk.status).toBe(400);
  });

  it('maps an embedding provider failure to 502', async () => {
    const failing = await setup(
      scriptedPorts({
        embed: async () => Promise.reject(new Error('vendor 500')),
      }),
    );
    const res = await ingest(failing.app, failing.tokenA, {
      title: 'T',
      text: 'hello world body',
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('embedding_failed');
  });

  it('reports 503 when knowledge is not configured', async () => {
    const unconfigured = await setup(null);
    const res = await ingest(unconfigured.app, unconfigured.tokenA, {
      title: 'T',
      text: 'hello world body',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('knowledge_not_configured');
  });
});

describe('knowledge query route', () => {
  let s: Setup;
  let docIdA: string;
  beforeEach(async () => {
    s = await setup();
    for (const text of ['alpha', 'beta', 'gamma']) {
      const res = await ingest(s.app, s.tokenA, { title: `doc-${text}`, text });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { document: { id: string } };
      if (text === 'alpha') docIdA = body.document.id;
    }
  });

  interface QueryResponse {
    query: string;
    top_k: number;
    answer: string | null;
    reranked: boolean;
    citations: Array<{
      chunk_id: string;
      doc_id: string;
      title: string;
      position: number;
      score: number;
      content: string;
    }>;
  }

  async function query(
    token: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return s.app.request('/v1/knowledge/query', {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify(body),
    });
  }

  it('returns vector-ranked citations with provenance', async () => {
    const res = await query(s.tokenA, { query: 'alpha', top_k: 2 });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.top_k).toBe(2);
    expect(outcome.reranked).toBe(false); // no rerank port configured
    expect(outcome.citations.map((c) => c.content)).toEqual(['alpha', 'gamma']);
    expect(outcome.citations[0]?.score).toBeCloseTo(1, 6);
    expect(outcome.citations[0]?.title).toBe('doc-alpha');
    expect(outcome.citations[0]?.position).toBe(0);
  });

  it('keeps owners isolated: B never sees A documents', async () => {
    await ingest(s.app, s.tokenB, { title: 'doc-beta-b', text: 'beta' });

    const listB = await s.app.request('/v1/knowledge/documents', {
      headers: bearer(s.tokenB),
    });
    const docsB = (await listB.json()) as {
      documents: Array<{ title: string }>;
    };
    expect(docsB.documents.map((d) => d.title)).toEqual(['doc-beta-b']);

    const res = await query(s.tokenB, { query: 'alpha', top_k: 5 });
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.citations).toHaveLength(1);
    expect(outcome.citations[0]?.content).toBe('beta');

    const del = await s.app.request(`/v1/knowledge/documents/${docIdA}`, {
      method: 'DELETE',
      headers: bearer(s.tokenB),
    });
    expect(del.status).toBe(404);

    const delOwn = await s.app.request(`/v1/knowledge/documents/${docIdA}`, {
      method: 'DELETE',
      headers: bearer(s.tokenA),
    });
    expect(delOwn.status).toBe(200);
  });

  it('reorders by rerank scores and flags reranked', async () => {
    const reranked = await setup(
      scriptedPorts({
        rerank: async (_query, contents) =>
          contents.map((c) => (c === 'gamma' ? 100 : 0)),
        answer: async (_query, contexts) =>
          `grounded in ${contexts.length} passages`,
      }),
    );
    for (const text of ['alpha', 'beta', 'gamma']) {
      const res = await ingest(reranked.app, reranked.tokenA, {
        title: `doc-${text}`,
        text,
      });
      expect(res.status).toBe(201);
    }
    const res = await reranked.app.request('/v1/knowledge/query', {
      method: 'POST',
      headers: bearer(reranked.tokenA),
      body: JSON.stringify({ query: 'alpha', top_k: 2 }),
    });
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.reranked).toBe(true);
    expect(outcome.citations.map((c) => c.content)).toEqual(['gamma', 'alpha']);
    expect(outcome.answer).toBe('grounded in 2 passages');
  });

  it('falls back to the vector order when the reranker fails', async () => {
    const flaky = await setup(
      scriptedPorts({
        rerank: async () => Promise.reject(new Error('rerank model down')),
        // Wrong-length scores must also be ignored.
      }),
    );
    for (const text of ['alpha', 'beta', 'gamma']) {
      await ingest(flaky.app, flaky.tokenA, { title: `doc-${text}`, text });
    }
    const res = await flaky.app.request('/v1/knowledge/query', {
      method: 'POST',
      headers: bearer(flaky.tokenA),
      body: JSON.stringify({ query: 'alpha', top_k: 2 }),
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.reranked).toBe(false);
    expect(outcome.citations.map((c) => c.content)).toEqual(['alpha', 'gamma']);
  });

  it('ignores wrong-length rerank output', async () => {
    const wrong = await setup(
      scriptedPorts({ rerank: async (_q, contents) => contents.slice(0, 1).map(() => 99) }),
    );
    for (const text of ['alpha', 'beta', 'gamma']) {
      await ingest(wrong.app, wrong.tokenA, { title: `doc-${text}`, text });
    }
    const res = await wrong.app.request('/v1/knowledge/query', {
      method: 'POST',
      headers: bearer(wrong.tokenA),
      body: JSON.stringify({ query: 'alpha', top_k: 3 }),
    });
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.reranked).toBe(false);
    expect(outcome.citations[0]?.content).toBe('alpha');
  });

  it('returns citations with a null answer when the answerer fails', async () => {
    const broken = await setup(
      scriptedPorts({
        answer: async () => Promise.reject(new Error('answer model down')),
      }),
    );
    await ingest(broken.app, broken.tokenA, { title: 'doc-alpha', text: 'alpha' });
    const res = await broken.app.request('/v1/knowledge/query', {
      method: 'POST',
      headers: bearer(broken.tokenA),
      body: JSON.stringify({ query: 'alpha' }),
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.answer).toBeNull();
    expect(outcome.citations).toHaveLength(1);
  });

  it('answers with an empty citation list for owners without documents', async () => {
    const res = await query(s.tokenB, { query: 'alpha' });
    const outcome = (await res.json()) as QueryResponse;
    expect(outcome.citations).toEqual([]);
    expect(outcome.answer).toBeNull();
  });

  it('validates the query body', async () => {
    const empty = await query(s.tokenA, { query: '' });
    expect(empty.status).toBe(400);
    const badTopK = await query(s.tokenA, { query: 'x', top_k: 99 });
    expect(badTopK.status).toBe(400);
    const unknown = await query(s.tokenA, { query: 'x', nope: true });
    expect(unknown.status).toBe(400);
  });
});
