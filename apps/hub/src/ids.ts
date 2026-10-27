import { randomBytes } from 'node:crypto';

// Generate a prefixed, opaque row id, e.g. newId('prov') -> "prov_<32 hex>".
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

// Current time as an ISO 8601 string, used for all timestamp columns.
export function nowIso(): string {
  return new Date().toISOString();
}
