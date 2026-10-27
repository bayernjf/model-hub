import type {
  ProjectedModel,
  ResolvedModel,
} from './types.js';

// Convert a wire projection to the camelCase resolved view.
export function toResolved(
  m: ProjectedModel,
  source: ResolvedModel['source'] = 'hub',
): ResolvedModel {
  return {
    assignmentId: m.assignment_id,
    alias: m.alias,
    role: m.role,
    modalities: m.modalities,
    model: m.model,
    litellmId: m.litellm_id,
    displayName: m.display_name,
    protocol: m.protocol,
    baseUrl: m.base_url,
    apiKey: m.api_key,
    endpoints: m.endpoints,
    adapter: m.adapter,
    contextWindow: m.context_window,
    supportsJson: m.supports_json,
    supportsStream: m.supports_stream,
    dailyBudgetMicros: m.daily_budget_micros,
    pricing: m.pricing,
    source,
  };
}

export function listModels(
  models: ProjectedModel[],
  modality?: string,
): ResolvedModel[] {
  const projected = modality
    ? models.filter((m) => m.modalities.includes(modality))
    : models;
  return projected.map((m) => toResolved(m, 'hub'));
}

export function resolveByAlias(
  models: ProjectedModel[],
  alias: string,
): ResolvedModel | undefined {
  const found = models.find((m) => m.alias === alias);
  return found ? toResolved(found, 'hub') : undefined;
}

// Return the primary model for a modality. Throws when none is available;
// the caller decides whether to fall back to env or fail closed.
export function primaryFor(
  models: ProjectedModel[],
  modality: string,
): ResolvedModel | undefined {
  const candidates = models.filter((m) => m.modalities.includes(modality));
  const primary = candidates.find((m) => m.role === 'primary');
  const fallback = primary ?? candidates[0];
  return fallback ? toResolved(fallback, 'hub') : undefined;
}
