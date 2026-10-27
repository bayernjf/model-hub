import type {
  BillingSource,
  ResolvedModel,
} from './types.js';

export interface UsageInput {
  project: string;
  feature: string;
  billingSource: BillingSource;
  model: ResolvedModel;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  httpStatus: number;
  cached?: boolean | undefined;
}

// Fire-and-forget usage report. Never blocks or throws into the caller.
export async function postUsage(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  input: UsageInput,
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
    ts: new Date().toISOString(),
  };
  try {
    await fetchImpl(`${hubUrl.replace(/\/+$/, '')}/pub/v1/usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // reporting must not affect the workflow
  }
}

// Schedule a report without awaiting it (returns the promise for callers
// that want to flush before shutdown).
export function reportUsageInBackground(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  input: UsageInput,
): Promise<void> {
  return postUsage(hubUrl, token, fetchImpl, input);
}
