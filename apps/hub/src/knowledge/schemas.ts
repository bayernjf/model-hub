import { z } from 'zod';
import {
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
} from './chunker.js';
import { MAX_TOP_K } from './service.js';

// Shared request validation for the knowledge API (project-token routes and
// the admin console routes use the same contract).

const SUPPORTED_MIMES = ['text/plain', 'text/markdown'] as const;

export const KnowledgeIngestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    text: z.string().min(1).max(200_000),
    mime: z.enum(SUPPORTED_MIMES).optional(),
    source: z.string().max(60).optional(),
    chunk_size: z
      .number()
      .int()
      .min(MIN_CHUNK_SIZE)
      .max(MAX_CHUNK_SIZE)
      .optional(),
    chunk_overlap: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (v) => (v.chunk_overlap ?? 0) < (v.chunk_size ?? DEFAULT_CHUNK_SIZE),
    { message: 'chunk_overlap must be smaller than chunk_size', path: ['chunk_overlap'] },
  );

export type KnowledgeIngestRequest = z.infer<typeof KnowledgeIngestSchema>;

export const KnowledgeQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
    top_k: z.number().int().min(1).max(MAX_TOP_K).optional(),
    rerank: z.boolean().optional(),
  })
  .strict();

export type KnowledgeQueryRequest = z.infer<typeof KnowledgeQuerySchema>;

export { SUPPORTED_MIMES };
