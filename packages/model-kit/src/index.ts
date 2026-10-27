import { readCache, writeCache } from './cache.js';
import { pullCatalog, CatalogPullError } from './catalog.js';
import {
  listModels,
  primaryFor,
  resolveByAlias,
} from './resolve.js';
import { pingHub, runTest } from './health.js';
import type {
  CatalogResponse,
  DriverFactory,
  ModelKitOptions,
  PingResult,
  ProjectedModel,
  ResolvedModel,
  TestResult,
} from './types.js';

export const KIT_VERSION = '0.1.0';

export const MODALITIES = [
  'text',
  'image',
  'video',
  'audio',
  'embedding',
] as const;

export type Modality = (typeof MODALITIES)[number];

export function isModality(value: string): value is Modality {
  return (MODALITIES as readonly string[]).includes(value);
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionError';
  }
}

function envToResolved(
  alias: string,
  env: { baseUrl: string; apiKey: string; model: string },
): ResolvedModel {
  return {
    assignmentId: '',
    alias,
    role: 'primary',
    modalities: ['text'],
    model: env.model,
    litellmId: null,
    displayName: null,
    protocol: 'openai-compatible',
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    endpoints: { chat: '/chat/completions' },
    adapter: {},
    contextWindow: null,
    supportsJson: false,
    supportsStream: false,
    dailyBudgetMicros: null,
    pricing: null,
    source: 'env',
  };
}

export class ModelKit {
  private catalog: CatalogResponse | null = null;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ModelKitOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  // Initial load: pull, fall back to cache, then env. Never starts bare:
  // resolution fails closed when no source can provide a model.
  async init(): Promise<this> {
    const cached = readCache(this.options.cachePath);
    if (cached) this.catalog = cached;

    try {
      const outcome = await pullCatalog(
        this.options.hubUrl,
        this.options.token,
        this.fetchImpl,
        this.catalog?.revision,
      );
      if (!outcome.notModified && outcome.data) {
        this.catalog = outcome.data;
        writeCache(this.options.cachePath, outcome.data);
      }
    } catch (err) {
      // Pull failed; keep the cache if present. A missing cache is not fatal
      // here because the project may rely on env fallback.
      if (!this.catalog && err instanceof CatalogPullError) {
        // leave catalog null; resolution will attempt env / fail closed.
      }
    }

    const interval = this.options.refreshIntervalMs ?? 5 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.refresh();
    }, interval);
    // Do not keep the process alive solely for the refresh timer.
    this.timer.unref?.();

    return this;
  }

  // Background refresh; on failure the existing catalog is retained.
  async refresh(): Promise<void> {
    try {
      const outcome = await pullCatalog(
        this.options.hubUrl,
        this.options.token,
        this.fetchImpl,
        this.catalog?.revision,
      );
      if (!outcome.notModified && outcome.data) {
        this.catalog = outcome.data;
        writeCache(this.options.cachePath, outcome.data);
      }
    } catch {
      // retain current catalog/cache
    }
  }

  private get models(): ProjectedModel[] {
    return this.catalog?.models ?? [];
  }

  get revision(): number | null {
    return this.catalog?.revision ?? null;
  }

  list(modality?: string): ResolvedModel[] {
    return listModels(this.models, modality);
  }

  // Resolution order: project BYOK -> hub projection -> env fallback ->
  // fail closed. Never defaults to a paid model implicitly.
  resolve(alias: string): ResolvedModel {
    if (this.options.resolveByok) {
      const byok = this.options.resolveByok(alias);
      if (byok) return byok;
    }

    const fromHub = resolveByAlias(this.models, alias);
    if (fromHub) return fromHub;

    const env = this.options.envFallback?.[alias];
    if (env) return envToResolved(alias, env);

    throw new ResolutionError(
      `no model resolved for alias '${alias}' (BYOK/hub/env all unavailable)`,
    );
  }

  // Primary hub model for a modality, then env fallback, then fail closed.
  primary(modality: string): ResolvedModel {
    const fromHub = primaryFor(this.models, modality);
    if (fromHub) return fromHub;

    const env = this.options.envFallback?.[modality];
    if (env) return envToResolved(modality, env);

    throw new ResolutionError(
      `no primary model for modality '${modality}'`,
    );
  }

  async pingHub(): Promise<PingResult> {
    return pingHub(this.options.hubUrl, this.options.token, this.fetchImpl);
  }

  async testConnection(
    target: string | ResolvedModel,
    opts?: { deep?: boolean; driverFactory?: DriverFactory },
  ): Promise<TestResult> {
    const model =
      typeof target === 'string' ? this.resolve(target) : target;
    return runTest(model, {
      driverFactory: opts?.driverFactory,
      fetchImpl: this.fetchImpl,
      deep: opts?.deep,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export async function initModelKit(
  options: ModelKitOptions,
): Promise<ModelKit> {
  return new ModelKit(options).init();
}

export type {
  CatalogResponse,
  DriverFactory,
  ModelKitOptions,
  PingResult,
  ProjectedModel,
  ResolvedModel,
  TestResult,
} from './types.js';
