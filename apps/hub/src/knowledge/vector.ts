// Vector math for the MVP brute-force retrieval: embeddings are read from
// SQLite and scored in memory with cosine similarity. No vector extension.

/** Cosine similarity in [-1, 1]; -1 for empty or dimension-mismatched
 * vectors so bad rows simply sink to the bottom of the ranking. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Parse a stored embedding JSON string; returns null on malformed rows so
 * one bad chunk cannot take down a whole query. */
export function parseEmbedding(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.every((n) => typeof n === 'number') ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}
