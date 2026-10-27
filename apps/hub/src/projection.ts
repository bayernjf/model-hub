import type {
  EndpointSet,
  Pricing,
  Protocol,
} from './presets/types.js';
import type { ProviderRepository } from './repositories/providers.js';
import type { ModelRepository } from './repositories/models.js';
import type { AssignmentRepository } from './repositories/assignments.js';

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

// Builds the projected catalog a project receives: assignments joined with
// models and providers, only when all three layers are enabled, and with the
// vendor credential decrypted into the payload.
export class ProjectionService {
  constructor(
    private readonly providerRepo: ProviderRepository,
    private readonly modelRepo: ModelRepository,
    private readonly assignmentRepo: AssignmentRepository,
  ) {}

  projectFor(projectId: string): ProjectedModel[] {
    const assignments = this.assignmentRepo.listByProject(projectId);
    const out: ProjectedModel[] = [];

    for (const assignment of assignments) {
      const model = this.modelRepo.get(assignment.model_id);
      if (!model || !model.enabled) continue;

      const provider = this.providerRepo.get(model.provider_id);
      if (!provider || !provider.enabled) continue;

      const apiKey = this.providerRepo.revealKey(provider.id);
      if (!apiKey) continue;

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
