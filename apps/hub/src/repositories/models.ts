import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../ids.js';
import { getPresetProvider, type PresetModel } from '../presets/index.js';
import type {
  AdapterDialect,
  EndpointSet,
  Modality,
  Pricing,
} from '../presets/types.js';
import type {
  ManualModelCreate,
  ModelOverlayPatch,
} from '../model-schemas.js';

interface ModelRow {
  id: string;
  provider_id: string;
  preset_model_id: string | null;
  model: string;
  display_name: string | null;
  modalities: string;
  litellm_id: string | null;
  context_window: number | null;
  supports_json: number;
  supports_stream: number;
  pricing: string | null;
  endpoints_override: string | null;
  adapter: string | null;
  is_default: number;
  sort_order: number;
  enabled: number;
  reasoning: number;
  created_at: string;
  updated_at: string;
}

export interface ModelView {
  id: string;
  provider_id: string;
  preset_model_id: string | null;
  model: string;
  display_name: string | null;
  modalities: Modality[];
  litellm_id: string | null;
  context_window: number | null;
  supports_json: boolean;
  supports_stream: boolean;
  pricing: Pricing;
  endpoints_override: EndpointSet | null;
  adapter: AdapterDialect | null;
  is_default: boolean;
  sort_order: number;
  enabled: boolean;
  reasoning: boolean;
  created_at: string;
  updated_at: string;
}

export interface ImportResult {
  imported: ModelView[];
  skipped: string[];
}

export class PresetNotFoundError extends Error {
  constructor(presetProviderId: string) {
    super(`preset provider not found: ${presetProviderId}`);
    this.name = 'PresetNotFoundError';
  }
}

export class ModelConflictError extends Error {
  constructor(model: string) {
    super(`model already exists for provider: ${model}`);
    this.name = 'ModelConflictError';
  }
}

function parseJsonArray(value: string | null): Modality[] {
  if (!value) return [];
  return JSON.parse(value) as Modality[];
}

function parseJsonObject<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

function toView(row: ModelRow): ModelView {
  return {
    id: row.id,
    provider_id: row.provider_id,
    preset_model_id: row.preset_model_id,
    model: row.model,
    display_name: row.display_name,
    modalities: parseJsonArray(row.modalities),
    litellm_id: row.litellm_id,
    context_window: row.context_window,
    supports_json: row.supports_json === 1,
    supports_stream: row.supports_stream === 1,
    pricing: parseJsonObject<Pricing>(row.pricing) ?? {},
    endpoints_override: parseJsonObject<EndpointSet>(row.endpoints_override),
    adapter: parseJsonObject<AdapterDialect>(row.adapter),
    is_default: row.is_default === 1,
    sort_order: row.sort_order,
    enabled: row.enabled === 1,
    reasoning: row.reasoning === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ModelRepository {
  constructor(private readonly db: DatabaseSync) {}

  private rowById(id: string): ModelRow | null {
    const row = this.db
      .prepare('SELECT * FROM model_overlays WHERE id = ?')
      .get(id) as ModelRow | undefined;
    return row ?? null;
  }

  private rowByProviderAndModel(
    providerId: string,
    model: string,
  ): ModelRow | null {
    const row = this.db
      .prepare('SELECT * FROM model_overlays WHERE provider_id = ? AND model = ?')
      .get(providerId, model) as ModelRow | undefined;
    return row ?? null;
  }

  get(id: string): ModelView | null {
    const row = this.rowById(id);
    return row ? toView(row) : null;
  }

  listByProvider(providerId: string): ModelView[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM model_overlays WHERE provider_id = ? ORDER BY sort_order, created_at, id',
      )
      .all(providerId) as unknown as ModelRow[];
    return rows.map(toView);
  }

  listAll(): ModelView[] {
    const rows = this.db
      .prepare('SELECT * FROM model_overlays ORDER BY provider_id, sort_order, id')
      .all() as unknown as ModelRow[];
    return rows.map(toView);
  }

  private insertModel(params: {
    providerId: string;
    presetModelId: string | null;
    model: string;
    displayName: string | null;
    modalities: Modality[];
    litellmId?: string | undefined;
    contextWindow?: number | undefined;
    supportsJson: boolean;
    supportsStream: boolean;
    pricing: Pricing;
    endpoints?: EndpointSet | undefined;
    adapter?: AdapterDialect | undefined;
    isDefault: boolean;
    sortOrder: number;
    enabled: boolean;
    reasoning: boolean;
  }): ModelView {
    const id = newId('mdl');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO model_overlays
           (id, provider_id, preset_model_id, model, display_name, modalities,
            litellm_id, context_window, supports_json, supports_stream, pricing,
            endpoints_override, adapter, is_default, sort_order, enabled,
            reasoning, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.providerId,
        params.presetModelId,
        params.model,
        params.displayName,
        JSON.stringify(params.modalities),
        params.litellmId ?? null,
        params.contextWindow ?? null,
        params.supportsJson ? 1 : 0,
        params.supportsStream ? 1 : 0,
        JSON.stringify(params.pricing),
        params.endpoints ? JSON.stringify(params.endpoints) : null,
        params.adapter ? JSON.stringify(params.adapter) : null,
        params.isDefault ? 1 : 0,
        params.sortOrder,
        params.enabled ? 1 : 0,
        params.reasoning ? 1 : 0,
        now,
        now,
      );
    return this.get(id) as ModelView;
  }

  // Batch-import preset models. Imported models are disabled by default;
  // models already present under the provider are skipped (idempotent).
  importFromPreset(
    providerId: string,
    presetProviderId: string,
    modelIds: string[],
  ): ImportResult {
    const preset = getPresetProvider(presetProviderId);
    if (!preset) throw new PresetNotFoundError(presetProviderId);

    const byId = new Map<string, PresetModel>(
      preset.models.map((m) => [m.id, m]),
    );

    const imported: ModelView[] = [];
    const skipped: string[] = [];

    for (const modelId of modelIds) {
      const presetModel = byId.get(modelId);
      if (!presetModel) {
        skipped.push(modelId);
        continue;
      }
      if (this.rowByProviderAndModel(providerId, presetModel.model)) {
        skipped.push(modelId);
        continue;
      }
      imported.push(
        this.insertModel({
          providerId,
          presetModelId: presetModel.id,
          model: presetModel.model,
          displayName: presetModel.display_name,
          modalities: presetModel.modalities,
          litellmId: presetModel.litellm_id,
          contextWindow: presetModel.context_window,
          supportsJson: presetModel.supports_json,
          supportsStream: presetModel.supports_stream,
          pricing: presetModel.pricing,
          endpoints: presetModel.endpoints,
          adapter: presetModel.adapter,
          isDefault: false,
          sortOrder: imported.length,
          enabled: false, // imported models are not enabled by default
          reasoning: presetModel.reasoning ?? false,
        }),
      );
    }

    return { imported, skipped };
  }

  // Enter a model manually (no preset). Disabled by default unless requested.
  createManual(providerId: string, input: ManualModelCreate): ModelView {
    if (this.rowByProviderAndModel(providerId, input.model)) {
      throw new ModelConflictError(input.model);
    }
    return this.insertModel({
      providerId,
      presetModelId: null,
      model: input.model,
      displayName: input.display_name,
      modalities: input.modalities,
      litellmId: input.litellm_id,
      contextWindow: input.context_window,
      supportsJson: input.supports_json ?? false,
      supportsStream: input.supports_stream ?? false,
      pricing: input.pricing ?? {},
      endpoints: input.endpoints,
      adapter: input.adapter as AdapterDialect | undefined,
      isDefault: input.is_default ?? false,
      sortOrder: input.sort_order ?? 0,
      enabled: input.enabled ?? false,
      reasoning: input.reasoning ?? false,
    });
  }

  // Apply an owner overlay patch; only the strict allow-list fields change.
  updateOverlay(id: string, patch: ModelOverlayPatch): ModelView | null {
    if (!this.rowById(id)) return null;

    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.modalities !== undefined)
      assign('modalities', JSON.stringify(patch.modalities));
    if (patch.pricing !== undefined)
      assign('pricing', JSON.stringify(patch.pricing));
    if (patch.enabled !== undefined) assign('enabled', patch.enabled ? 1 : 0);
    if (patch.is_default !== undefined)
      assign('is_default', patch.is_default ? 1 : 0);
    if (patch.sort_order !== undefined)
      assign('sort_order', patch.sort_order);
    if (patch.reasoning !== undefined)
      assign('reasoning', patch.reasoning ? 1 : 0);

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(nowIso());
      values.push(id);
      this.db
        .prepare(`UPDATE model_overlays SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(values as never[]));
    }

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM model_overlays WHERE id = ?')
      .run(id);
    return Number(result.changes) > 0;
  }
}
