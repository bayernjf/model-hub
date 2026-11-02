import { describe, expect, it, vi } from 'vitest';
import {
  AllProviderKeysExhaustedError,
  ProviderRequestError,
  classifyProviderError,
} from '../src/provider-errors.js';

describe('classifyProviderError', () => {
  it('rotates only on a 429 whose body names a quota condition', () => {
    const quotaBodies = [
      { error: { code: 'RateLimitExceeded', message: 'Your account quota is exceeded' } },
      { error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } },
      { error: { code: 'quota_exhausted', message: '5小时额度已用尽' } },
      { code: 'BalanceInsufficient', message: '余额不足，请充值' },
      { error: { code: 'x', message: 'arrears on subscription' } },
    ];
    for (const body of quotaBodies) {
      expect(classifyProviderError(429, body)).toBe('quota_exhausted');
    }
  });

  it('does not rotate on ordinary rate limiting', () => {
    const ordinary = [
      { error: { code: 'TooManyRequests', message: 'Rate limit reached for requests' } },
      { error: { code: '429', message: 'rpm limit exceeded, slow down' } },
      { error: { type: 'requests_rate_limit', message: 'TPM rate limit' } },
      null, // 429 with no body: never rotate blindly
    ];
    for (const body of ordinary) {
      expect(classifyProviderError(429, body)).toBe('rate_limited');
    }
  });

  it('does not rotate on 401/403/5xx (including the observed Ark auth error)', () => {
    const arkInvalidKey = {
      error: {
        code: 'AuthenticationError',
        type: 'Unauthorized',
        message: "The API key doesn't exist.",
      },
    };
    expect(classifyProviderError(401, arkInvalidKey)).toBe('other');
    expect(classifyProviderError(403, { error: { code: 'Forbidden' } })).toBe('other');
    expect(classifyProviderError(500, { error: { message: 'internal' } })).toBe('other');
    expect(classifyProviderError(429, { error: { code: 'QuotaExceeded' } })).not.toBe('other');
  });

  it('uses the dedicated exhaustion/request errors', () => {
    const exhausted = new AllProviderKeysExhaustedError(429, { error: { code: 'QuotaExceeded' } });
    expect(exhausted).toBeInstanceOf(Error);
    expect(exhausted.lastStatus).toBe(429);
    const request = new ProviderRequestError(401, { error: {} });
    expect(request.status).toBe(401);
    void vi; // keeps import referenced if suite grows
  });
});
