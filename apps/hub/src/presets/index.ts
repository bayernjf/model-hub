import { PRESET_CATALOG } from './catalog.js';
import type { PresetModel, PresetProvider } from './types.js';

export * from './types.js';
export { PRESET_CATALOG } from './catalog.js';

/** All preset providers (the catalog shown before a real provider exists). */
export function listPresetProviders(): PresetProvider[] {
  return PRESET_CATALOG.presets;
}

/** Look up a preset provider by its id (e.g. `ark`). */
export function getPresetProvider(id: string): PresetProvider | null {
  return PRESET_CATALOG.presets.find((p) => p.id === id) ?? null;
}

/** Look up a preset model by provider id and catalog model id. */
export function getPresetModel(
  providerId: string,
  modelId: string,
): PresetModel | null {
  const provider = getPresetProvider(providerId);
  return provider?.models.find((m) => m.id === modelId) ?? null;
}
