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

// Base field sets (without .refine) so both the project-token schema and the
// admin schema (with an explicit owner) can be derived from one source.
const IngestFields = z
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
  .strict();

const overlapFitsSize = (v: {
  chunk_overlap?: number | undefined;
  chunk_size?: number | undefined;
}): boolean =>
  (v.chunk_overlap ?? 0) < (v.chunk_size ?? DEFAULT_CHUNK_SIZE);

const overlapError = {
  message: 'chunk_overlap must be smaller than chunk_size',
  path: ['chunk_overlap'] as PropertyKey[],
};

export const KnowledgeIngestSchema = IngestFields.refine(
  overlapFitsSize,
  overlapError,
);

export type KnowledgeIngestRequest = z.infer<typeof KnowledgeIngestSchema>;

// Admin console variant: the owner project is chosen explicitly.
export const AdminKnowledgeIngestSchema = IngestFields.extend({
  owner: z.string().min(1),
})
  .strict()
  .refine(overlapFitsSize, overlapError);

export const KnowledgeQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
    top_k: z.number().int().min(1).max(MAX_TOP_K).optional(),
    rerank: z.boolean().optional(),
  })
  .strict();

export type KnowledgeQueryRequest = z.infer<typeof KnowledgeQuerySchema>;

export const AdminKnowledgeQuerySchema = KnowledgeQuerySchema.extend({
  owner: z.string().min(1),
}).strict();

export { SUPPORTED_MIMES };
