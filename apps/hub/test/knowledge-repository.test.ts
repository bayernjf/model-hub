import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/open.js';
import { migrateUp } from '../src/db/migrate.js';
import { KnowledgeRepository } from '../src/knowledge/repository.js';
import type { DatabaseSync } from 'node:sqlite';

function makeRepo(): { repo: KnowledgeRepository; db: DatabaseSync } {
  const db = openDatabase(':memory:');
  migrateUp(db);
  return { repo: new KnowledgeRepository(db), db };
}

const A = 'prj_aaaa';
const B = 'prj_bbbb';

function twoChunks() {
  return [
    { position: 0, content: 'refund policy: 30 days', embedding: '[0.1,0.2]', token_count: 6 },
    { position: 1, content: 'shipping policy: 5 days', embedding: '[0.3,0.4]', token_count: 6 },
  ];
}

describe('knowledge repository', () => {
  it('creates a document with chunks atomically and reports chunk counts', () => {
    const { repo } = makeRepo();
    const doc = repo.createDocumentWithChunks({
      owner: A,
      title: 'Policies',
      source: 'console',
      mime: 'text/markdown',
      chunks: twoChunks(),
    });

    expect(doc.id).toMatch(/^doc_/);
    expect(doc.owner).toBe(A);

    const listed = repo.listDocuments(A);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.chunk_count).toBe(2);
    expect(listed[0]?.title).toBe('Policies');
  });

  it('keeps documents of different owners isolated on list and get', () => {
    const { repo } = makeRepo();
    const doc = repo.createDocumentWithChunks({
      owner: A,
      title: 'A doc',
      source: 'api',
      mime: 'text/plain',
      chunks: twoChunks(),
    });

    expect(repo.listDocuments(B)).toEqual([]);

    expect(repo.getDocument(doc.id, B)).toBeNull();
    expect(repo.getDocument(doc.id, A)?.title).toBe('A doc');
    expect(repo.getDocument('doc_missing', A)).toBeNull();
  });

  it('deletes chunks together with the document, only for the owner', () => {
    const { repo } = makeRepo();
    const doc = repo.createDocumentWithChunks({
      owner: A,
      title: 'Policies',
      source: null,
      mime: null,
      chunks: twoChunks(),
    });

    expect(repo.deleteDocument(doc.id, B)).toBe(false);
    expect(repo.listDocuments(A)).toHaveLength(1);
    expect(repo.countChunks(doc.id)).toBe(2);

    expect(repo.deleteDocument(doc.id, A)).toBe(true);
    expect(repo.listDocuments(A)).toEqual([]);
    expect(repo.countChunks(doc.id)).toBe(0);
    expect(repo.deleteDocument(doc.id, A)).toBe(false);
  });

  it('rolls back the whole document when a chunk insert fails', () => {
    const { repo, db } = makeRepo();
    // Force a chunk-insert failure by dropping the chunks table; the
    // document row must not survive the aborted transaction.
    db.exec('DROP TABLE chunks');

    expect(() =>
      repo.createDocumentWithChunks({
        owner: A,
        title: 'Broken',
        source: null,
        mime: null,
        chunks: twoChunks(),
      }),
    ).toThrow();

    const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get() as {
      n: number;
    };
    expect(Number(docs.n)).toBe(0);
  });

  it('lists embedded chunks scoped to the owner with doc titles', () => {
    const { repo } = makeRepo();
    const embedded = repo.createDocumentWithChunks({
      owner: A,
      title: 'Embedded',
      source: null,
      mime: null,
      chunks: twoChunks(),
    });
    repo.createDocumentWithChunks({
      owner: A,
      title: 'No vectors',
      source: null,
      mime: null,
      chunks: [{ position: 0, content: 'plain', embedding: null, token_count: 1 }],
    });
    repo.createDocumentWithChunks({
      owner: B,
      title: 'Other owner',
      source: null,
      mime: null,
      chunks: twoChunks(),
    });

    const chunks = repo.listEmbeddedChunks(A);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.doc_id === embedded.id)).toBe(true);
    expect(chunks.every((c) => c.doc_title === 'Embedded')).toBe(true);
    expect(chunks.map((c) => c.position)).toEqual([0, 1]);

    expect(repo.listEmbeddedChunks(B)).toHaveLength(2);
  });
});
