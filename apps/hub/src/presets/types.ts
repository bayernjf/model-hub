/**
 * Types for the versioned preset catalog.
 *
 * Field naming follows the project-facing contract (`contracts/schemas/common.json`):
 * modalities, protocols, billing types and the multi-dimensional pricing keys
 * are the same strings, so a preset model can be copied into `model_overlays`
 * and projected to projects without renaming.
 */

export const MODALITIES = [
  'text',
  'image',
  'video',
  'audio',
  'embedding',
] as const;
export type Modality = (typeof MODALITIES)[number];

export const PROTOCOLS = [
  'openai-compatible',
  'anthropic',
  'gemini',
] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const BILLING_TYPES = ['payg', 'subscription'] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

/**
 * Multi-dimensional pricing in USD. Which fields apply depends on modality:
 *  - text/embedding: *_usd_per_million token prices
 *  - image:          per_image
 *  - video:          per_second
 *  - audio:          per_second / per_kilo_char / per_mega_utf8_byte
 * A null (or omitted) field means "unknown / not billed here"; an explicit 0
 * declares a free model. Mirrors the contract `pricing` object.
 */
export interface Pricing {
  input_usd_per_million?: number | null | undefined;
  output_usd_per_million?: number | null | undefined;
  cache_read_usd_per_million?: number | null | undefined;
  per_image?: number | null | undefined;
  per_second?: number | null | undefined;
  per_kilo_char?: number | null | undefined;
  per_mega_utf8_byte?: number | null | undefined;
}

/**
 * Per-provider sub-paths for each modality, relative to the base URL.
 * Mirrors the contract `endpoints` object.
 */
export interface EndpointSet {
  chat?: string | undefined;
  images?: string | undefined;
  videos?: string | undefined;
  audio?: string | undefined;
  embeddings?: string | undefined;
}

/**
 * Description of a non-standard dialect (e.g. async video submit/poll). The
 * core fields match the contract `adapter` object; the extra fields carry the
 * verified provider-specific details (the contract allows additional
 * properties). Projects use these to adapt without per-vendor code branches.
 */
export interface AdapterDialect {
  submit_path?: string;
  poll_path?: string;
  status_path?: string;
  result_path?: string;
  status_field?: string;
  succeeded_values?: string[];
  failed_values?: string[];
  id_field?: string;
  poll_interval_ms?: number;
  // Verified video-dialect extras.
  create_body?: Record<string, unknown>;
  retrieval_url_template?: string;
  result_url_path?: string;
  duration_path?: string;
  seconds_field?: string;
  seconds_range?: [number, number];
  aspect_as_ratio?: boolean;
  first_frame_path?: string;
  images_path?: string;
  max_n?: number;
  omit_duration?: boolean;
  // Voice-dialect auth. `x-api-key` sends the credential in X-Api-Key and
  // carries a resource id (ByteDance openspeech TTS/ASR); `bearer` is the
  // standard Authorization header. These are not secrets.
  auth_style?: 'bearer' | 'x-api-key';
  resource_id?: string;
  // ASR single-stream (nostream) mode: the whole utterance is returned at once.
  nonstream?: boolean;
}

/** A model offered by a preset provider. */
export interface PresetModel {
  /** Stable catalog id, unique within the catalog. */
  id: string;
  /** Model id sent to the API (may carry a date suffix). */
  model: string;
  display_name: string;
  modalities: Modality[];
  /** LiteLLM identifier for Python projects, e.g. `openai/<model>`. */
  litellm_id?: string;
  context_window?: number;
  supports_json: boolean;
  supports_stream: boolean;
  /** Whether the model is a reasoning model (emits reasoning_tokens). */
  reasoning?: boolean;
  pricing: Pricing;
  /** Provider-level default endpoints; absent entries use the standard set. */
  endpoints?: EndpointSet;
  adapter?: AdapterDialect;
  note?: string;
}

/** A preset provider (vendor) and its model catalog. */
export interface PresetProvider {
  id: string;
  name: string;
  protocol: Protocol;
  billing_type: BillingType;
  default_base_url: string;
  key_label: string;
  models: PresetModel[];
}

/** The whole versioned catalog. */
export interface PresetCatalog {
  /** Catalog schema version, bumped on structural changes. */
  catalog_version: string;
  /** Human-readable note on how the prices were sourced/converted. */
  sourcing_note: string;
  presets: PresetProvider[];
}
