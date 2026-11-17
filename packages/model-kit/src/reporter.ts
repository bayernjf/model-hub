import type {
  BillingSource,
  ResolvedModel,
} from './types.js';

// Tier0 org M3 F3.1: optional org attribution carried through the report so
// the hub can answer "what did this position / department / task cost". Callers
// without org context omit it and the hub columns stay NULL.
export interface UsageDimensions {
  position_id?: string | undefined;
  department_id?: string | undefined;
  task_id?: string | undefined;
}

export interface UsageInput {
  project: string;
  feature: string;
  billingSource: BillingSource;
  model: ResolvedModel;
  usageDimensions?: UsageDimensions | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  httpStatus: number;
  cached?: boolean | undefined;
  /** True when the kit rerouted the call to a fallback (budget governance,
   * FR6-2); lets the hub ledger attribute degraded spend. */
  degraded?: boolean | undefined;
}

// Fire-and-forget usage report. Never blocks or throws into the caller.
// `onError` is an optional observer: the swallow stays in place, but a failed
// report (HTTP non-2xx or network error) is no longer invisible.
export async function postUsage(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  input: UsageInput,
  onError?: (reason: string) => void,
): Promise<void> {
  const body = {
    project: input.project,
    feature: input.feature,
    billing_source: input.billingSource,
    provider: input.model.adapter?.dialect ?? input.model.model,
    model: input.model.model,
    assignment_id: input.model.assignmentId || null,
    input_tokens: input.inputTokens ?? 0,
    output_tokens: input.outputTokens ?? 0,
    cache_read_tokens: input.cacheReadTokens ?? 0,
    reasoning_tokens: input.reasoningTokens ?? null,
    http_status: input.httpStatus,
    cached: input.cached ?? false,
    degraded: input.degraded ?? false,
    // Only spread present values: the hub schema treats absent and null alike
    // (both mean "no org attribution") and .strict() rejects unknown keys.
    ...(input.usageDimensions?.position_id
      ? { position_id: input.usageDimensions.position_id }
      : {}),
    ...(input.usageDimensions?.department_id
      ? { department_id: input.usageDimensions.department_id }
      : {}),
    ...(input.usageDimensions?.task_id
      ? { task_id: input.usageDimensions.task_id }
      : {}),
    ts: new Date().toISOString(),
  };
  try {
    const response = await fetchImpl(`${hubUrl.replace(/\/+$/, '')}/pub/v1/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      onError?.(`usage report failed: HTTP ${response.status}`);
    }
  } catch (error) {
    // reporting must not affect the workflow; the observer (when present)
    // records the failure, it never rethrows into the caller.
    onError?.(error instanceof Error ? error.message : 'usage report network error');
  }
}

// Schedule a report without awaiting it (returns the promise for callers
// that want to flush before shutdown).
export function reportUsageInBackground(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  input: UsageInput,
  onError?: (reason: string) => void,
): Promise<void> {
  return postUsage(hubUrl, token, fetchImpl, input, onError);
}
