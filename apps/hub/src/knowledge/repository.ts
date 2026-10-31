import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../ids.js';

// Knowledge base storage (PRD F3 / M3): owner-scoped documents and their
// embedded chunks. Owner is the project id from the token auth surface, so
// every read/write is scoped by owner to keep projects isolated.

export interface DocumentRecord {
  id: string;
  owner: string;
  title: string;
  source: string | null;
  mime: string | null;
  created_at: string;
}

export interface DocumentWithCount extends DocumentRecord {
  chunk_count: number;
}

export interface ChunkInsert {
  position: number;
  content: string;
  /** JSON-encoded embedding vector, or null when embedding failed. */
  embedding: string | null;
  token_count: number | null;
}

export interface ChunkRecord {
  id: string;
  doc_id: string;
  position: number;
  content: string;
  embedding: string | null;
  token_count: number | null;
}

export interface ChunkWithDoc extends ChunkRecord {
  doc_title: string;
}

interface DocumentRow {
  id: string;
  owner: string;
  title: string;
  source: string | null;
  mime: string | null;
  created_at: string;
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    source: row.source,
    mime: row.mime,
    created_at: row.created_at,
  };
}

export class KnowledgeRepository {
  constructor(private readonly db: DatabaseSync) {}

  // Insert the document and all of its chunks atomically: a partially
  // ingested document would silently shrink retrieval coverage.
  createDocumentWithChunks(input: {
    owner: string;
    title: string;
    source: string | null;
    mime: string | null;
    chunks: ChunkInsert[];
  }): DocumentRecord {
    const id = newId('doc');
    const createdAt = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO documents (id, owner, title, source, mime, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.owner, input.title, input.source, input.mime, createdAt);

      const insertChunk = this.db.prepare(
        `INSERT INTO chunks
           (id, doc_id, position, content, embedding, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of input.chunks) {
        insertChunk.run(
          newId('chk'),
          id,
          chunk.position,
          chunk.content,
          chunk.embedding,
          chunk.token_count,
          createdAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      id,
      owner: input.owner,
      title: input.title,
      source: input.source,
      mime: input.mime,
      created_at: createdAt,
    };
  }

  listDocuments(owner: string): DocumentWithCount[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, COUNT(c.id) AS chunk_count
         FROM documents d
         LEFT JOIN chunks c ON c.doc_id = d.id
         WHERE d.owner = ?
         GROUP BY d.id
         ORDER BY d.created_at DESC, d.id ASC`,
      )
      .all(owner) as unknown as Array<DocumentRow & { chunk_count: number }>;
    return rows.map((row) => ({ ...toDocument(row), chunk_count: row.chunk_count }));
  }

  // Owner-scoped single fetch; a document from another owner reads as absent.
  getDocument(id: string, owner: string): DocumentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM documents WHERE id = ? AND owner = ?')
      .get(id, owner) as DocumentRow | undefined;
    return row ? toDocument(row) : null;
  }

  countChunks(docId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?')
      .get(docId) as { n: number };
    return Number(row.n);
  }

  // Delete chunks and the document row when (and only when) the document
  // belongs to the owner. Returns whether a document was deleted.
  deleteDocument(id: string, owner: string): boolean {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `DELETE FROM chunks WHERE doc_id IN (
             SELECT id FROM documents WHERE id = ? AND owner = ?
           )`,
        )
        .run(id, owner);
      const result = this.db
        .prepare('DELETE FROM documents WHERE id = ? AND owner = ?')
        .run(id, owner);
      this.db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // All embedded chunks of one owner, joined with the document title for
  // citation output. MVP brute-force scan reads the full set per query.
  listEmbeddedChunks(owner: string): ChunkWithDoc[] {
    return this.db
      .prepare(
        `SELECT c.id, c.doc_id, c.position, c.content, c.embedding,
                c.token_count, d.title AS doc_title
         FROM chunks c
         JOIN documents d ON d.id = c.doc_id
         WHERE d.owner = ? AND c.embedding IS NOT NULL
         ORDER BY c.doc_id ASC, c.position ASC`,
      )
      .all(owner) as unknown as ChunkWithDoc[];
  }
}
