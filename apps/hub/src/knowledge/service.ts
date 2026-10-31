import { chunkText, estimateTokens } from './chunker.js';
import { ValidationError } from '../validation.js';
import type {
  ChunkInsert,
  DocumentRecord,
  DocumentWithCount,
  KnowledgeRepository,
} from './repository.js';

// Pluggable model ports (PRD F3): the hub calls its own assigned models
// through model-kit, but tests inject fakes. Optional ports are simply
// absent when the corresponding alias is not configured.
export interface KnowledgePorts {
  embed(inputs: string[]): Promise<number[][]>;
  rerank?:
    | ((query: string, contents: string[]) => Promise<number[]>)
    | undefined;
  answer?:
    | ((query: string, contexts: string[]) => Promise<string | null>)
    | undefined;
}

// Resolved lazily so boot never depends on the knowledge consumer token.
// Returning null means knowledge embedding is not configured.
export type KnowledgePortsResolver = () => Promise<KnowledgePorts | null>;

export class KnowledgeNotConfiguredError extends Error {
  constructor() {
    super(
      'knowledge retrieval is not configured (KNOWLEDGE_PROJECT_TOKEN is unset)',
    );
    this.name = 'KnowledgeNotConfiguredError';
  }
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface IngestInput {
  title: string;
  text: string;
  mime?: string | undefined;
  source?: string | undefined;
  chunkSize?: number | undefined;
  chunkOverlap?: number | undefined;
}

export interface IngestResult {
  document: DocumentRecord;
  chunk_count: number;
}

export interface Citation {
  chunk_id: string;
  doc_id: string;
  title: string;
  position: number;
  score: number;
  content: string;
}

export interface QueryInput {
  query: string;
  topK?: number | undefined;
  rerank?: boolean | undefined;
}

export interface QueryOutcome {
  query: string;
  top_k: number;
  /** Natural-language answer; null when no answer alias or it failed. */
  answer: string | null;
  citations: Citation[];
  /** Whether the LLM reranker actually reordered the vector results. */
  reranked: boolean;
}

export const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 50;

export interface KnowledgeDeps {
  repo: KnowledgeRepository;
  ports: KnowledgePortsResolver;
}

export class KnowledgeService {
  constructor(private readonly deps: KnowledgeDeps) {}

  private async requirePorts(): Promise<KnowledgePorts> {
    const ports = await this.deps.ports();
    if (!ports) throw new KnowledgeNotConfiguredError();
    return ports;
  }

  // Upload → split → embed → store. All-or-nothing: the document row only
  // appears once every chunk has a vector, so listing never shows a
  // half-ingested document.
  async ingest(owner: string, input: IngestInput): Promise<IngestResult> {
    const ports = await this.requirePorts();
    const pieces = chunkText(input.text, {
      size: input.chunkSize,
      overlap: input.chunkOverlap,
    });
    if (pieces.length === 0) {
      throw new ValidationError('text', 'text has no content after trimming');
    }

    const vectors = await ports.embed(pieces);
    if (vectors.length !== pieces.length) {
      throw new EmbeddingError(
        `embedding count mismatch: sent ${pieces.length}, got ${vectors.length}`,
      );
    }

    const chunks: ChunkInsert[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) {
        throw new EmbeddingError(`empty embedding vector for chunk ${i}`);
      }
      chunks.push({
        position: i,
        content: pieces[i] as string,
        embedding: JSON.stringify(vector),
        token_count: estimateTokens(pieces[i] as string),
      });
    }

    const document = this.deps.repo.createDocumentWithChunks({
      owner,
      title: input.title,
      source: input.source ?? 'api',
      mime: input.mime ?? 'text/plain',
      chunks,
    });
    return { document, chunk_count: chunks.length };
  }

  listDocuments(owner: string): DocumentWithCount[] {
    return this.deps.repo.listDocuments(owner);
  }

  getDocument(owner: string, id: string): DocumentRecord | null {
    return this.deps.repo.getDocument(id, owner);
  }

  deleteDocument(owner: string, id: string): boolean {
    return this.deps.repo.deleteDocument(id, owner);
  }
}
