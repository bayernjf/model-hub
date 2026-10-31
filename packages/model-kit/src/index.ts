import { readCache, writeCache } from './cache.js';
import { pullCatalog, CatalogPullError } from './catalog.js';
import {
  listModels,
  primaryFor,
  resolveByAlias,
} from './resolve.js';
import {
  budgetStateFor,
  fetchUsageSummary,
  isBudgetEnforcementEnabled,
  pickModelForCall,
  type BudgetState,
} from './budget.js';
import { pingHub, runTest } from './health.js';
import { completeJson, streamChat } from './driver.js';
import type { ChatMessage, ChatResult, StreamChunk } from './driver.js';
import { embedJson, generateImage, generateVideo } from './media.js';
import type { EmbedResult, ImageResult, VideoResult } from './media.js';
import { synthesize } from './audio.js';
import type { TtsResult } from './audio.js';
import { nodeWsFactory, transcribe } from './asr.js';
import type { AsrResult, AsrSocketFactory } from './asr.js';
import { reportUsageInBackground } from './reporter.js';
import type {
  CatalogResponse,
  DegradationInfo,
  DriverFactory,
  ModelKitOptions,
  PingResult,
  ProjectedModel,
  ResolvedModel,
  TestResult,
  UsageSummary,
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
  // Last /pub/v1/usage/summary snapshot; aligned with the catalog refresh
  // cadence (see pullBudgetSummary). Null until the first successful pull.
  private budgetSummary: UsageSummary | null = null;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ModelKitOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  // Cost governance kill switch (W5-2): 'off' disables the entire budget
  // layer — no summary fetch, no enforcement, no degradation.
  private get governanceEnabled(): boolean {
    return isBudgetEnforcementEnabled(this.options.budgetEnforcement);
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

    await this.pullBudgetSummary();

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
    await this.pullBudgetSummary();
  }

  // Refresh the budget readout (W5-1). Runs on the same cadence as the
  // catalog refresh (default every 5 minutes, plus once per init/refresh).
  // Fail-soft: on error the previous snapshot is retained (or stays null),
  // and enforcement treats an unknown spend as under budget so a hub outage
  // never blocks calls.
  private async pullBudgetSummary(): Promise<void> {
    if (!this.governanceEnabled) return;
    try {
      this.budgetSummary = await fetchUsageSummary(
        this.options.hubUrl,
        this.options.token,
        this.fetchImpl,
      );
    } catch {
      // keep the previous summary, if any
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

  /**
   * Budget readout for one alias (W5-1): UTC-day spend from the hub summary
   * against the assignment's daily budget. Returns null when the alias has
   * no hub assignment (BYOK/env) or when the governance layer is disabled.
   *
   * Immediacy: the snapshot is refreshed with the catalog (init plus the
   * shared timer, default every 5 minutes), so it can lag the hub ledger by
   * up to one refresh interval plus usage-report latency. In-process calls
   * made since the last refresh are not reflected until the next pull.
   */
  getDailyBudgetState(alias: string): BudgetState | null {
    if (!this.governanceEnabled) return null;
    return budgetStateFor(this.models, this.budgetSummary, alias);
  }

  // Pre-call budget check shared by every alias call. Returns the model to
  // use (possibly a fallback) plus degradation provenance; throws
  // BudgetExceededError when over budget with no fallback available.
  private precheck(
    alias: string,
    modality: string,
  ): { model: ResolvedModel; degraded: DegradationInfo | null } {
    if (!this.governanceEnabled) {
      return { model: this.resolve(alias), degraded: null };
    }
    return pickModelForCall(
      this.models,
      this.budgetSummary,
      alias,
      modality,
      (a) => this.resolve(a),
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

  // Fire a usage report after a call. BYOK is reported with no hub cost.
  // Degraded calls (rerouted by budget governance) are flagged so the hub
  // ledger can attribute the spend (FR6-2).
  private reportUsage(
    feature: string,
    model: ResolvedModel,
    usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      reasoning_tokens?: number;
    } | null,
    httpStatus: number,
    degraded?: DegradationInfo | null,
  ): void {
    const project = this.catalog?.project ?? model.alias ?? 'unknown';
    void reportUsageInBackground(
      this.options.hubUrl,
      this.options.token,
      this.fetchImpl,
      {
        project,
        feature,
        billingSource: model.source === 'byok' ? 'byok' : 'builtin',
        model,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        reasoningTokens: usage?.reasoning_tokens,
        httpStatus,
        ...(degraded ? { degraded: true } : {}),
      },
    );
  }

  // Non-streaming chat with automatic background usage reporting.
  async chat(
    alias: string,
    messages: ChatMessage[],
    opts?: {
      signal?: AbortSignal | undefined;
      maxTokens?: number | undefined;
      temperature?: number | undefined;
    },
  ): Promise<ChatResult> {
    const { model, degraded } = this.precheck(alias, 'text');
    const result = await completeJson(
      {
        model,
        messages,
        signal: opts?.signal,
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
      },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, result.usage, result.httpStatus, degraded);
    return degraded ? { ...result, degraded } : result;
  }

  // Streaming chat; reports usage from the final include_usage frame. The
  // final done chunk carries the degradation provenance when rerouted.
  async *stream(
    alias: string,
    messages: ChatMessage[],
    opts?: {
      signal?: AbortSignal | undefined;
      maxTokens?: number | undefined;
      temperature?: number | undefined;
    },
  ): AsyncGenerator<StreamChunk> {
    const { model, degraded } = this.precheck(alias, 'text');
    let usage: StreamChunk['usage'] = null;
    for await (const chunk of streamChat(
      {
        model,
        messages,
        signal: opts?.signal,
        maxTokens: opts?.maxTokens,
        temperature: opts?.temperature,
      },
      this.fetchImpl,
    )) {
      if (chunk.usage) usage = chunk.usage;
      yield degraded && chunk.done ? { ...chunk, degraded } : chunk;
    }
    this.reportUsage(alias, model, usage, 200, degraded);
  }

  // Embed text into vectors (synchronous). Reports the provider-echoed
  // input token count so embedding spend lands in the hub cost ledger.
  async embed(
    alias: string,
    input: string | string[],
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<EmbedResult> {
    const { model, degraded } = this.precheck(alias, 'embedding');
    const result = await embedJson(
      { model, input, signal: opts?.signal },
      this.fetchImpl,
    );
    this.reportUsage(
      alias,
      model,
      result.usage
        ? { prompt_tokens: result.usage.prompt_tokens, completion_tokens: 0 }
        : null,
      result.httpStatus,
      degraded,
    );
    return degraded ? { ...result, degraded } : result;
  }

  // Generate an image (synchronous); returns the image URL.
  async image(
    alias: string,
    prompt: string,
    opts?: { size?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<ImageResult> {
    const { model, degraded } = this.precheck(alias, 'image');
    const result = await generateImage(
      { model, prompt, size: opts?.size, signal: opts?.signal },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, null, result.httpStatus, degraded);
    return degraded ? { ...result, degraded } : result;
  }

  // Generate a video (async submit + poll per the adapter dialect); returns the
  // final video URL once the task completes.
  async video(
    alias: string,
    prompt: string,
    opts?: {
      signal?: AbortSignal | undefined;
      pollTimeoutMs?: number | undefined;
    },
  ): Promise<VideoResult> {
    const { model, degraded } = this.precheck(alias, 'video');
    const result = await generateVideo(
      {
        model,
        prompt,
        signal: opts?.signal,
        pollTimeoutMs: opts?.pollTimeoutMs,
      },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, null, result.httpStatus, degraded);
    return degraded ? { ...result, degraded } : result;
  }

  // Synthesize speech (HTTP TTS). Returns decoded audio bytes (Doubao voice)
  // or a URL (OpenAI-compatible TTS).
  async tts(
    alias: string,
    text: string,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<TtsResult> {
    const { model, degraded } = this.precheck(alias, 'audio');
    const result = await synthesize(
      { model, text, signal: opts?.signal },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, null, result.httpStatus, degraded);
    return degraded ? { ...result, degraded } : result;
  }

  // Recognize speech (ASR over the SAUC binary WebSocket protocol). Returns
  // the transcript text plus per-utterance details.
  async asr(
    alias: string,
    audio: Uint8Array,
    opts?: {
      chunkMs?: number | undefined;
      timeoutMs?: number | undefined;
      rawPcm?: boolean | undefined;
      uid?: string | undefined;
      signal?: AbortSignal | undefined;
      request?: Record<string, unknown> | undefined;
    },
  ): Promise<AsrResult> {
    const { model, degraded } = this.precheck(alias, 'audio');
    const factory: AsrSocketFactory =
      this.options.webSocketFactory ?? nodeWsFactory;
    const result = await transcribe(
      {
        model,
        audio,
        chunkMs: opts?.chunkMs,
        timeoutMs: opts?.timeoutMs,
        rawPcm: opts?.rawPcm,
        uid: opts?.uid,
        signal: opts?.signal,
        request: opts?.request,
      },
      factory,
    );
    this.reportUsage(alias, model, null, 200, degraded);
    return degraded ? { ...result, degraded } : result;
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
  AdapterConfig,
  BillingSource,
  CatalogResponse,
  DriverFactory,
  ModelKitOptions,
  PingResult,
  ProjectedModel,
  Protocol,
  ResolvedModel,
  Role,
  TestResult,
} from './types.js';

export {
  completeJson,
  streamChat,
} from './driver.js';
export type {
  ChatMessage,
  ChatResult,
  StreamChunk,
  TokenUsage,
} from './driver.js';

export { embedJson, generateImage, generateVideo } from './media.js';
export type { EmbedResult, EmbedUsage, ImageResult, VideoResult } from './media.js';

export { synthesize } from './audio.js';
export type { TtsResult } from './audio.js';

export {
  buildAudioOnly,
  buildFullRequest,
  nodeWsFactory,
  parseFrame,
  parseWav,
  transcribe,
} from './asr.js';
export type {
  AsrResult,
  AsrSocket,
  AsrSocketFactory,
  ParsedAsrFrame,
  TranscribeCall,
  WavData,
} from './asr.js';

export { postUsage, reportUsageInBackground } from './reporter.js';
export type { UsageInput } from './reporter.js';

export {
  budgetStateFor,
  fetchUsageSummary,
  isBudgetEnforcementEnabled,
  pickModelForCall,
  BudgetExceededError,
  BudgetStateError,
} from './budget.js';
export type { BudgetState } from './budget.js';
export type {
  DegradationInfo,
  UsageSummary,
  UsageSummaryModel,
} from './types.js';

export { createFakeFetch, FakeProviderError } from './fake.js';
