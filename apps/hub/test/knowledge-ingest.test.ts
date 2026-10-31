import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/open.js';
import { migrateUp } from '../src/db/migrate.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import {
  EmbeddingError,
  KnowledgeNotConfiguredError,
  KnowledgeService,
} from '../src/knowledge/service.js';
import type { KnowledgePorts } from '../src/knowledge/service.js';
import type { DatabaseSync } from 'node:sqlite';

const OWNER = 'prj_owner';

function fakePorts(overrides: Partial<KnowledgePorts> = {}): KnowledgePorts {
  return {
    embed: async (inputs) => inputs.map((_, i) => [i, 1, 0]),
    ...overrides,
  };
}

function makeService(
  ports: KnowledgePorts | null,
): { svc: KnowledgeService; repo: KnowledgeRepository; db: DatabaseSync } {
  const db = openDatabase(':memory:');
  migrateUp(db);
  const repo = new KnowledgeRepository(db);
  const svc = new KnowledgeService({ repo, ports: async () => ports });
  return { svc, repo, db };
}

const SAMPLE = 'refund policy line. '.repeat(80); // ~1600 chars -> 2 chunks at 1000/200

describe('knowledge service ingest', () => {
  it('splits, embeds and stores chunks with owner and metadata', async () => {
    const { svc } = makeService(fakePorts());
    const result = await svc.ingest(OWNER, {
      title: 'Policies',
      text: SAMPLE,
      mime: 'text/markdown',
      source: 'console',
    });

    expect(result.chunk_count).toBe(2);
    expect(result.document.owner).toBe(OWNER);
    expect(result.document.title).toBe('Policies');
    expect(result.document.mime).toBe('text/markdown');
    expect(result.document.source).toBe('console');

    const docs = svc.listDocuments(OWNER);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.chunk_count).toBe(2);
  });

  it('defaults source to api and mime to text/plain', async () => {
    const { svc } = makeService(fakePorts());
    const result = await svc.ingest(OWNER, { title: 'T', text: 'short body' });
    expect(result.document.source).toBe('api');
    expect(result.document.mime).toBe('text/plain');
  });

  it('honors per-request chunk size and overlap overrides', async () => {
    const { svc } = makeService(fakePorts());
    const result = await svc.ingest(OWNER, {
      title: 'T',
      text: 'x'.repeat(250),
      chunkSize: 100,
      chunkOverlap: 0,
    });
    expect(result.chunk_count).toBe(3);
  });

  it('stores the embedding JSON and a positive token estimate per chunk', async () => {
    const { svc, repo } = makeService(fakePorts());
    const { document } = await svc.ingest(OWNER, {
      title: 'T',
      text: SAMPLE,
    });
    const chunks = repo.listEmbeddedChunks(OWNER);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.doc_id).toBe(document.id);
      const vector = JSON.parse(chunk.embedding as string) as number[];
      expect(vector).toEqual([chunk.position, 1, 0]);
      expect(chunk.token_count ?? 0).toBeGreaterThan(0);
    }
  });

  it('rejects empty content before contacting the embedder', async () => {
    const { svc } = makeService(fakePorts());
    await expect(
      svc.ingest(OWNER, { title: 'T', text: '   \n  ' }),
    ).rejects.toThrow();
  });

  it('fails without storing the document when embedding throws', async () => {
    const { svc } = makeService(
      fakePorts({
        embed: async () => Promise.reject(new Error('provider down')),
      }),
    );
    await expect(
      svc.ingest(OWNER, { title: 'T', text: SAMPLE }),
    ).rejects.toThrow('provider down');
    expect(svc.listDocuments(OWNER)).toEqual([]);
  });

  it('fails when the embedder returns a mismatched count', async () => {
    const { svc } = makeService(
      fakePorts({ embed: async (inputs) => inputs.slice(0, 1).map(() => [1]) }),
    );
    await expect(
      svc.ingest(OWNER, { title: 'T', text: SAMPLE }),
    ).rejects.toBeInstanceOf(EmbeddingError);
    expect(svc.listDocuments(OWNER)).toEqual([]);
  });

  it('raises not-configured when ports resolve to null', async () => {
    const { svc } = makeService(null);
    await expect(
      svc.ingest(OWNER, { title: 'T', text: 'hello' }),
    ).rejects.toBeInstanceOf(KnowledgeNotConfiguredError);
  });

  it('scopes delete by owner', async () => {
    const { svc } = makeService(fakePorts());
    const { document } = await svc.ingest(OWNER, {
      title: 'T',
      text: 'hello world content for deletion',
    });

    expect(svc.deleteDocument('prj_other', document.id)).toBe(false);
    expect(svc.listDocuments(OWNER)).toHaveLength(1);
    expect(svc.deleteDocument(OWNER, document.id)).toBe(true);
    expect(svc.listDocuments(OWNER)).toEqual([]);
  });
});
