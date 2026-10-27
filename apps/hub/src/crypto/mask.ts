// Secret masking and round-trip detection. UI/API responses expose only the
// mask; when a masked value is submitted back, the caller treats it as
// "unchanged" and keeps the stored secret.

const MASK_TOKEN = '****';

// Return a mask that keeps only the last four characters. Very short secrets
// are fully masked so nothing is revealed.
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return MASK_TOKEN;
  return `${MASK_TOKEN}${secret.slice(-4)}`;
}

// True when the value is a generated mask rather than a real secret.
export function isMasked(value: string): boolean {
  return value.includes(MASK_TOKEN);
}
