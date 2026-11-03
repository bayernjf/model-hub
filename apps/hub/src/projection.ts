import type {
  EndpointSet,
  Pricing,
  Protocol,
} from './presets/types.js';
import type { ProviderRepository } from './repositories/providers.js';
import type { ModelRepository } from './repositories/models.js';
import type { AssignmentRepository } from './repositories/assignments.js';
import type { ProviderKeyRepository, UsableKey } from './repositories/provider-keys.js';
import { nowIso } from './ids.js';

export interface ProjectedApiKey {
  key: string;
  keyId: string;
  label: string;
}

export interface ProjectedModel {
  assignment_id: string;
  alias: string | null;
  role: string;
  daily_budget_micros: number | null;
  modalities: string[];
  model: string;
  litellm_id: string | null;
  display_name: string | null;
  protocol: string;
  base_url: string;
  api_key: string;
  // Ordered usable credential pool (active + not cooled down). Length >= 1
  // whenever the model is projected; legacy clients keep reading api_key.
  api_keys: ProjectedApiKey[];
  endpoints: EndpointSet;
  adapter: Record<string, unknown> | null;
  context_window: number | null;
  supports_json: boolean;
  supports_stream: boolean;
  pricing: Pricing;
}

const DEFAULT_ENDPOINTS: Record<Protocol, EndpointSet> = {
  'openai-compatible': {
    chat: '/chat/completions',
    images: '/images/generations',
    videos: '/videos',
    audio: '/audio/speech',
    embeddings: '/embeddings',
  },
  anthropic: { chat: '/v1/messages' },
  gemini: {},
};

function resolveEndpoints(
  protocol: Protocol,
  override: EndpointSet | null,
): EndpointSet {
  return { ...DEFAULT_ENDPOINTS[protocol], ...(override ?? {}) };
}

function toApiKeys(keys: UsableKey[]): ProjectedApiKey[] {
  return keys.map((k) => ({ key: k.key, keyId: k.keyId, label: k.label }));
}

// Builds the projected catalog a project receives: assignments joined with
// models and providers, only when all three layers are enabled, and with the
// vendor credential(s) decrypted into the payload.
export class ProjectionService {
  constructor(
    private readonly providerRepo: ProviderRepository,
    private readonly modelRepo: ModelRepository,
    private readonly assignmentRepo: AssignmentRepository,
    private readonly keyRepo?: ProviderKeyRepository,
  ) {}

  projectFor(projectId: string): ProjectedModel[] {
    const assignments = this.assignmentRepo.listByProject(projectId);
    const out: ProjectedModel[] = [];

    for (const assignment of assignments) {
      const model = this.modelRepo.get(assignment.model_id);
      if (!model || !model.enabled) continue;

      const provider = this.providerRepo.get(model.provider_id);
      if (!provider || !provider.enabled) continue;

      // Prefer the key pool; fall back to the legacy single provider key for
      // the migration period (014 backfills the pool, so in practice both
      // agree, but keep the read resilient).
      let apiKeys: ProjectedApiKey[] = [];
      if (this.keyRepo) {
        apiKeys = toApiKeys(this.keyRepo.usableKeys(provider.id, nowIso()));
      }
      if (apiKeys.length === 0) {
        const legacy = this.providerRepo.revealKey(provider.id);
        if (!legacy) continue;
        apiKeys = [{ key: legacy, keyId: '', label: '' }];
      }
      const apiKey = apiKeys[0]!.key;

      out.push({
        assignment_id: assignment.id,
        alias: assignment.alias,
        role: assignment.role,
        daily_budget_micros: assignment.daily_budget_micros,
        modalities: model.modalities,
        model: model.model,
        litellm_id: model.litellm_id,
        display_name: model.display_name,
        protocol: provider.protocol,
        base_url: provider.base_url,
        api_key: apiKey,
        api_keys: apiKeys,
        endpoints: resolveEndpoints(
          provider.protocol as Protocol,
          model.endpoints_override,
        ),
        adapter: model.adapter as Record<string, unknown> | null,
        context_window: model.context_window,
        supports_json: model.supports_json,
        supports_stream: model.supports_stream,
        pricing: model.pricing,
      });
    }

    return out;
  }
}
