// Shared front-end types for the console islands. These mirror the shapes the
// Hono API returns; the web workspace does not import server source.

export interface Provider {
  id: string;
  name: string;
  preset_id: string | null;
  protocol: string;
  base_url: string;
  billing_type: string;
  api_key_hint: string | null;
  has_api_key: boolean;
  enabled: boolean;
}

export interface ModelPricing {
  input_usd_per_million?: number | null | undefined;
  output_usd_per_million?: number | null | undefined;
  cache_read_usd_per_million?: number | null | undefined;
  per_image?: number | null | undefined;
  per_second?: number | null | undefined;
  per_kilo_char?: number | null | undefined;
  per_mega_utf8_byte?: number | null | undefined;
}

export interface ModelEndpoints {
  chat?: string | undefined;
  images?: string | undefined;
  videos?: string | undefined;
  audio?: string | undefined;
  embeddings?: string | undefined;
}

export interface ModelView {
  id: string;
  provider_id: string;
  preset_model_id: string | null;
  model: string;
  display_name: string | null;
  modalities: string[];
  litellm_id: string | null;
  context_window: number | null;
  supports_json: boolean;
  supports_stream: boolean;
  pricing: ModelPricing;
  endpoints_override: ModelEndpoints | null;
  adapter: Record<string, unknown> | null;
  is_default: boolean;
  sort_order: number;
  enabled: boolean;
  reasoning: boolean;
  created_at: string;
  updated_at: string;
}

export interface PresetModel {
  id: string;
  model: string;
  display_name: string;
  modalities: string[];
  reasoning?: boolean;
}

export interface PresetProvider {
  id: string;
  name: string;
  protocol: string;
  default_base_url: string;
  billing_type: string;
  key_label: string;
  models: PresetModel[];
}

export interface PresetsResponse {
  catalog_version: string;
  sourcing_note: string;
  presets: PresetProvider[];
}

export interface ConnectionTestResult {
  ok: boolean;
  latency_ms: number;
  model_echo?: string | null;
  error?: { code: string; hint?: string; detail?: string };
}
