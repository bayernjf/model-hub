import type { Pricing } from './presets/types.js';

const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;

export interface UsageUnits {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  quantity: number | null;
}

// Compute integer micro-USD cost from a pricing record and raw units.
// Token prices are per million, so micros simplify to tokens * price.
// reasoning_tokens are already part of output_tokens and are not added again.
export function computeCostMicros(
  pricing: Pricing,
  units: UsageUnits,
  modalities: string[],
): number {
  if (modalities.includes('text') || modalities.includes('embedding')) {
    let micros = 0;
    if (pricing.input_usd_per_million != null) {
      micros += units.input_tokens * pricing.input_usd_per_million;
    }
    if (pricing.output_usd_per_million != null) {
      micros += units.output_tokens * pricing.output_usd_per_million;
    }
    if (pricing.cache_read_usd_per_million != null) {
      micros += units.cache_read_tokens * pricing.cache_read_usd_per_million;
    }
    return Math.round(micros);
  }

  const quantity = units.quantity ?? 0;

  if (modalities.includes('image') && pricing.per_image != null) {
    return Math.round(quantity * pricing.per_image * MICROS_PER_USD);
  }

  if (modalities.includes('video') && pricing.per_second != null) {
    return Math.round(quantity * pricing.per_second * MICROS_PER_USD);
  }

  if (modalities.includes('audio')) {
    if (pricing.per_kilo_char != null && units.quantity != null) {
      // quantity is kilo-characters.
      return Math.round(quantity * pricing.per_kilo_char * MICROS_PER_USD);
    }
  }

  return 0;
}

// Re-export for clarity in tests/tooling.
export const TOKEN_DENOMINATOR = TOKENS_PER_MILLION;
