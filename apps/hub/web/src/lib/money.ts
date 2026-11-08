// Shared money / count formatting for console islands. Kept in one place so a
// statement and the cost dashboard can never disagree on how a number reads.

/**
 * micro-USD to a fixed 4-decimal dollar string.
 *
 * Below half a tenth of a cent the 4-decimal form rounds to "$0.0000", which
 * reads as free. A charge that exists is never rendered as zero: it shows as
 * "<$0.0001" instead, so "no charge" and "a tiny charge" stay distinguishable.
 */
export function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (micros > 0 && dollars < 0.00005) return '<$0.0001';
  return `$${dollars.toFixed(4)}`;
}

/** Token counts are large; group them so a bill is readable at a glance. */
export function tokens(value: number): string {
  return value.toLocaleString('en-US');
}
