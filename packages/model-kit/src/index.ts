import { readCache, writeCache } from './cache.js';
import { pullCatalog, CatalogPullError } from './catalog.js';
import {
  listModels,
  primaryFor,
  resolveByAlias,
} from './resolve.js';
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

  // Fire a usage report after a call. BYOK is reported with no hub cost.
  private reportUsage(
    feature: string,
    model: ResolvedModel,
    usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      reasoning_tokens?: number;
    } | null,
    httpStatus: number,
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
    const model = this.resolve(alias);
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
    this.reportUsage(alias, model, result.usage, result.httpStatus);
    return result;
  }

  // Streaming chat; reports usage from the final include_usage frame.
  async *stream(
    alias: string,
    messages: ChatMessage[],
    opts?: {
      signal?: AbortSignal | undefined;
      maxTokens?: number | undefined;
      temperature?: number | undefined;
    },
  ): AsyncGenerator<StreamChunk> {
    const model = this.resolve(alias);
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
      yield chunk;
    }
    this.reportUsage(alias, model, usage, 200);
  }

  // Embed text into vectors (synchronous). Reports the provider-echoed
  // input token count so embedding spend lands in the hub cost ledger.
  async embed(
    alias: string,
    input: string | string[],
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<EmbedResult> {
    const model = this.resolve(alias);
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
    );
    return result;
  }

  // Generate an image (synchronous); returns the image URL.
  async image(
    alias: string,
    prompt: string,
    opts?: { size?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<ImageResult> {
    const model = this.resolve(alias);
    const result = await generateImage(
      { model, prompt, size: opts?.size, signal: opts?.signal },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, null, result.httpStatus);
    return result;
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
    const model = this.resolve(alias);
    const result = await generateVideo(
      {
        model,
        prompt,
        signal: opts?.signal,
        pollTimeoutMs: opts?.pollTimeoutMs,
      },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, null, result.httpStatus);
    return result;
  }

  // Synthesize speech (HTTP TTS). Returns decoded audio bytes (Doubao voice)
  // or a URL (OpenAI-compatible TTS).
  async tts(
    alias: string,
    text: string,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<TtsResult> {
    const model = this.resolve(alias);
    const result = await synthesize(
      { model, text, signal: opts?.signal },
      this.fetchImpl,
    );
    this.reportUsage(alias, model, null, result.httpStatus);
    return result;
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
    const model = this.resolve(alias);
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
    this.reportUsage(alias, model, null, 200);
    return result;
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

export { createFakeFetch, FakeProviderError } from './fake.js';
