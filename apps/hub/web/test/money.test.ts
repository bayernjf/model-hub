import { describe, it, expect } from 'vitest';
import { tokens, usd } from '../src/lib/money.js';

describe('money formatting', () => {
  it('renders micro-USD with a stable four-decimal shape', () => {
    expect(usd(0)).toBe('$0.0000');
    expect(usd(1_000_000)).toBe('$1.0000');
    expect(usd(12_345)).toBe('$0.0123');
  });

  it('keeps four decimals so a small charge stays legible', () => {
    expect(usd(5_000)).toBe('$0.0050');
    expect(usd(50_000)).toBe('$0.0500');
  });

  it('never renders a non-zero charge as zero', () => {
    // 1 micro would round to "$0.0000" and read as free; it must say "<$0.0001".
    expect(usd(1)).toBe('<$0.0001');
    expect(usd(49)).toBe('<$0.0001');
    // Half a tenth of a cent is where the 4-decimal form starts telling the truth.
    expect(usd(50)).toBe('$0.0001');
  });

  it('groups token counts so large numbers stay readable', () => {
    expect(tokens(0)).toBe('0');
    expect(tokens(1_234_567)).toBe('1,234,567');
  });
});
