/**
 * Zod schemas for model import, manual entry and the owner overlay.
 *
 * The overlay write boundary is strict: only the six owner-editable fields
 * (modalities, pricing, enabled, is_default, sort_order, reasoning) are
 * accepted. Every credential or interface-dialect field — model, base_url,
 * api_key, protocol, endpoints, adapter, litellm_id — is rejected here so it
 * cannot be written through the catalog layer. Credentials live on the
 * provider entity.
 */
import { z } from 'zod';

export const ModalitySchema = z.enum([
  'text',
  'image',
  'video',
  'audio',
  'embedding',
]);

const optionalPrice = z.number().min(0).nullable().optional();

export const PricingSchema = z
  .object({
    input_usd_per_million: optionalPrice,
    output_usd_per_million: optionalPrice,
    cache_read_usd_per_million: optionalPrice,
    per_image: optionalPrice,
    per_second: optionalPrice,
    per_kilo_char: optionalPrice,
    per_mega_utf8_byte: optionalPrice,
  })
  .strict();
export type PricingInput = z.infer<typeof PricingSchema>;

export const EndpointSetSchema = z
  .object({
    chat: z.string().min(1).optional(),
    images: z.string().min(1).optional(),
    videos: z.string().min(1).optional(),
    audio: z.string().min(1).optional(),
    embeddings: z.string().min(1).optional(),
  })
  .strict();

// Dialect descriptions are code-shaped; preserve any verified fields.
export const AdapterSchema = z
  .object({
    submit_path: z.string().optional(),
    poll_path: z.string().optional(),
    status_path: z.string().optional(),
    result_path: z.string().optional(),
    status_field: z.string().optional(),
    succeeded_values: z.array(z.string()).optional(),
    failed_values: z.array(z.string()).optional(),
    id_field: z.string().optional(),
    poll_interval_ms: z.number().int().min(0).optional(),
    // Voice-dialect auth (ByteDance openspeech).
    auth_style: z.enum(['bearer', 'x-api-key']).optional(),
    resource_id: z.string().optional(),
  })
  .catchall(z.unknown());

/**
 * Owner overlay patch — the strict allow-list. `.strict()` rejects any key not
 * listed, including credential and dialect fields.
 */
export const ModelOverlayPatchSchema = z
  .object({
    modalities: z.array(ModalitySchema).optional(),
    pricing: PricingSchema.optional(),
    enabled: z.boolean().optional(),
    is_default: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
    reasoning: z.boolean().optional(),
  })
  .strict();
export type ModelOverlayPatch = z.infer<typeof ModelOverlayPatchSchema>;

/** Full catalog fields accepted when a model is entered manually. */
export const ManualModelCreateSchema = z
  .object({
    model: z.string().min(1).max(120),
    display_name: z.string().min(1).max(120),
    modalities: z.array(ModalitySchema).min(1),
    litellm_id: z.string().min(1).max(120).optional(),
    context_window: z.number().int().min(1).optional(),
    supports_json: z.boolean().optional(),
    supports_stream: z.boolean().optional(),
    pricing: PricingSchema.optional(),
    endpoints: EndpointSetSchema.optional(),
    adapter: AdapterSchema.optional(),
    is_default: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict();
export type ManualModelCreate = z.infer<typeof ManualModelCreateSchema>;

/** Request body for batch-importing preset models. */
export const ImportModelsSchema = z
  .object({
    preset_provider_id: z.string().min(1).max(64),
    model_ids: z.array(z.string().min(1).max(120)).min(1).max(200),
  })
  .strict();
export type ImportModelsInput = z.infer<typeof ImportModelsSchema>;

/** First zod issue message, for a compact 400 response. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid request';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
