import { describe, expect, it } from 'vitest';
import {
  chunkText,
  estimateTokens,
  MAX_CHUNKS_PER_DOC,
  resolveChunkOptions,
} from '../src/knowledge/chunker.js';

describe('chunk options', () => {
  it('defaults to 1000/200', () => {
    expect(resolveChunkOptions()).toEqual({ size: 1000, overlap: 200 });
  });

  it('rejects overlap >= size and non-integer or out-of-range sizes', () => {
    expect(() => resolveChunkOptions({ size: 100, overlap: 100 })).toThrow();
    expect(() => resolveChunkOptions({ size: 50 })).toThrow();
    expect(() => resolveChunkOptions({ size: 4001 })).toThrow();
    expect(() => resolveChunkOptions({ size: 100.5 })).toThrow();
    expect(() => resolveChunkOptions({ overlap: -1 })).toThrow();
  });
});

describe('chunkText', () => {
  it('returns a single chunk for text shorter than the window', () => {
    expect(chunkText('hello world', { size: 100, overlap: 20 })).toEqual([
      'hello world',
    ]);
  });

  it('returns one exact chunk for text of exactly size characters', () => {
    const text = 'a'.repeat(100);
    expect(chunkText(text, { size: 100, overlap: 20 })).toEqual([text]);
  });

  it('slides with stride = size - overlap and keeps the overlap content', () => {
    // size 100, overlap 50 -> stride 50 over a 220-char text.
    const text = '0123456789'.repeat(22);
    const chunks = chunkText(text, { size: 100, overlap: 50 });
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toBe(text.slice(0, 100));
    expect(chunks[1]).toBe(text.slice(50, 150));
    // The overlap: chunk 1 begins with the second half of chunk 0.
    expect(chunks[1]!.slice(0, 50)).toBe(chunks[0]!.slice(50));
    expect(chunks[3]).toBe(text.slice(150, 220));
  });

  it('carries real content across the overlap boundary', () => {
    const sentence =
      'The refund window is thirty days after purchase. Shipping takes five business days. Invoices go out at the start of every month automatically.';
    const chunks = chunkText(sentence, { size: 100, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every keyword survives in at least one chunk despite the splits.
    for (const word of ['refund', 'thirty', 'purchase', 'Shipping', 'Invoices']) {
      expect(chunks.some((c) => c.includes(word))).toBe(true);
    }
  });

  it('drops whitespace-only windows and trims chunk edges', () => {
    const text = `${'a'.repeat(200)}${' '.repeat(300)}${'b'.repeat(150)}`;
    const chunks = chunkText(text, { size: 100, overlap: 0 });
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
    expect(chunks[0]).toBe('a'.repeat(100));
    expect(chunks[chunks.length - 1]).toBe('b'.repeat(50));
  });

  it('caps the number of chunks for one document', () => {
    const text = 'x'.repeat(MAX_CHUNKS_PER_DOC * 150);
    expect(() => chunkText(text, { size: 100, overlap: 0 })).toThrow();
  });
});

describe('estimateTokens', () => {
  it('counts CJK characters roughly one token each', () => {
    expect(estimateTokens('退款政策')).toBe(4);
  });

  it('estimates latin text at about four characters per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('mixes both scripts', () => {
    expect(estimateTokens('退款refund')).toBe(2 + 2);
  });
});
