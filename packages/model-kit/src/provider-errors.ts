import type { ProviderErrorKind } from './types.js';

// Quota-class 429 classification (design §4). Only a 429 whose error payload
// names a subscription quota/balance condition triggers key rotation. Ordinary
// rate limiting (rpm/tpm/too many requests) must not rotate: the second key
// shares the same rate profile and would just burn it too.
//
// Substring match over lowercased code/type/message, covering Ark/OpenAI-style
// payloads plus common Chinese billing phrases. Tighten to an exact Ark error
// code once a real quota-exhausted body is observed (no schema change needed).
export const QUOTA_ERROR_PATTERNS: readonly string[] = [
  'quota',
  'exceed',
  'insufficient',
  'balance',
  'arrears',
  'out of credit',
  '额度',
  '配额',
  '欠费',
  '余额不足',
  '用尽',
];

// Marker strings in quota phrases are enough; any other 429 with a body is
// treated as ordinary rate limiting and does not rotate.

interface ErrorBody {
  error?: {
    code?: unknown;
    type?: unknown;
    message?: unknown;
  };
  code?: unknown;
  message?: unknown;
  type?: unknown;
}

function flatten(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as ErrorBody;
  const parts = [
    b.error?.code,
    b.error?.type,
    b.error?.message,
    b.code,
    b.type,
    b.message,
  ];
  return parts
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Classify a non-2xx provider response.
 * @param status HTTP status code
 * @param body parsed JSON body (or null)
 */
export function classifyProviderError(status: number, body: unknown): ProviderErrorKind {
  if (status !== 429 || !body) return 'other';
  const text = flatten(body);
  if (!text) return 'other'; // 429 with no body: never rotate blindly.
  if (QUOTA_ERROR_PATTERNS.some((p) => text.includes(p))) return 'quota_exhausted';
  // Any other 429 (rate-limit text or unrecognized) is transient, not a spent key.
  return 'rate_limited';
}

// Thrown when every key in the pool is quota-exhausted.
export class AllProviderKeysExhaustedError extends Error {
  readonly lastStatus: number;
  readonly lastBody: unknown;
  constructor(lastStatus: number, lastBody: unknown) {
    super('all provider API keys are quota-exhausted');
    this.name = 'AllProviderKeysExhaustedError';
    this.lastStatus = lastStatus;
    this.lastBody = lastBody;
  }
}

// Thrown for a non-quota provider failure during streaming (401/403/5xx or
// ordinary rate limiting). Callers should not retry with another key.
export class ProviderRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`provider request failed with status ${status}`);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.body = body;
  }
}
