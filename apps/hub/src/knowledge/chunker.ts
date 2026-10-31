// Fixed-length sliding-window chunker with overlap (PRD F3 FR3-2 MVP
// boundary: no semantic splitting). All sizes are in characters; chunks are
// trimmed and whitespace-only windows are dropped.

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;
export const MIN_CHUNK_SIZE = 100;
export const MAX_CHUNK_SIZE = 4000;
// Bounds the per-document embedding spend for a single ingest call.
export const MAX_CHUNKS_PER_DOC = 500;

export interface ChunkOptions {
  size: number;
  overlap: number;
}

// Input shape tolerates explicitly-undefined overrides (the service passes
// request fields straight through).
export interface ChunkOptionsInput {
  size?: number | undefined;
  overlap?: number | undefined;
}

export function resolveChunkOptions(
  overrides?: ChunkOptionsInput | undefined,
): ChunkOptions {
  const size = overrides?.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = overrides?.overlap ?? DEFAULT_CHUNK_OVERLAP;
  if (!Number.isInteger(size) || size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE) {
    throw new RangeError(
      `chunk size must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`,
    );
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new RangeError('chunk overlap must be an integer between 0 and size-1');
  }
  return { size, overlap };
}

export function chunkText(
  text: string,
  overrides?: ChunkOptionsInput | undefined,
): string[] {
  const { size, overlap } = resolveChunkOptions(overrides);
  const stride = size - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    const piece = text.slice(start, start + size).trim();
    if (piece.length > 0) chunks.push(piece);
    if (start + size >= text.length) break;
  }
  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    throw new RangeError(
      `document splits into more than ${MAX_CHUNKS_PER_DOC} chunks; split it before ingesting`,
    );
  }
  return chunks;
}

const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

// Cheap deterministic token estimate: CJK ideographs and kana count roughly
// one token per character, everything else about four characters per token.
// Informational only (displayed alongside chunks); cost accounting uses the
// tokens echoed by the embedding provider.
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
