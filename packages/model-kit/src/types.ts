// Project-side types mirroring the public contracts (snake_case on the wire).

export type Protocol = 'openai-compatible' | 'anthropic';
export type Role = 'primary' | 'fallback';
export type BillingSource = 'builtin' | 'byok';

export interface Pricing {
  input_usd_per_million?: number | undefined;
  output_usd_per_million?: number | undefined;
  cache_read_usd_per_million?: number | undefined;
  per_image?: number | undefined;
  per_second?: number | undefined;
  per_kilo_char?: number | undefined;
  per_mega_utf8_byte?: number | undefined;
}

export interface EndpointSet {
  chat?: string | undefined;
  embeddings?: string | undefined;
  images?: string | undefined;
  videos?: string | undefined;
  audio?: string | undefined;
}

export interface AdapterConfig {
  request_style?: string | undefined;
  dialect?: string | undefined;
  video_adapter?: string | undefined;
}

// One entry in GET /pub/v1/models.
export interface ProjectedModel {
  assignment_id: string;
  alias: string | null;
  role: Role;
  modalities: string[];
  model: string;
  litellm_id: string | null;
  display_name: string | null;
  protocol: Protocol;
  base_url: string;
  api_key: string;
  endpoints: EndpointSet;
  adapter: AdapterConfig | null;
  context_window: number | null;
  supports_json: boolean;
  supports_stream: boolean;
  daily_budget_micros: number | null;
  pricing: Pricing | null;
}

export interface CatalogResponse {
  project: string;
  revision: number;
  fetched_at: string;
  models: ProjectedModel[];
}

// CamelCase view returned by the resolver.
export interface ResolvedModel {
  assignmentId: string;
  alias: string | null;
  role: Role;
  modalities: string[];
  model: string;
  litellmId: string | null;
  displayName: string | null;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  endpoints: EndpointSet;
  adapter: AdapterConfig | null;
  contextWindow: number | null;
  supportsJson: boolean;
  supportsStream: boolean;
  dailyBudgetMicros: number | null;
  pricing: Pricing | null;
  // Where the resolution came from (for diagnostics).
  source: 'byok' | 'hub' | 'env';
}

export interface TestError {
  code: string;
  detail?: string | undefined;
  hint?: string | undefined;
}

export interface TestResult {
  ok: boolean;
  latency_ms: number;
  scope: string;
  auth_identity?: string | undefined;
  model_echo?: string | undefined;
  error?: TestError | undefined;
}

export interface PingResult {
  ok: boolean;
  revision?: number | undefined;
  latency_ms: number;
  error?: TestError | undefined;
}

// A project-supplied runtime driver used by L4 tests so they exercise the
// real call chain (LiteLLM, loom drivers, agent-world providers, ...).
export type DriverFactory = (
  model: ResolvedModel,
) => {
  probe: (opts?: { deep?: boolean | undefined }) => Promise<TestResult>;
};

export interface EnvFallback {
  // Migration-period env credentials, keyed by alias or modality.
  [key: string]:
    | { baseUrl: string; apiKey: string; model: string }
    | undefined;
}

export interface ModelKitOptions {
  token: string;
  hubUrl: string;
  cachePath: string;
  // Optional project-supplied BYOK resolver, evaluated before the hub.
  resolveByok?: (alias: string) => ResolvedModel | undefined;
  // Optional migration-period env fallback.
  envFallback?: EnvFallback;
  // Optional fetch override (tests).
  fetch?: typeof fetch;
  // Cache refresh interval in ms (default 5 minutes).
  refreshIntervalMs?: number;
}
