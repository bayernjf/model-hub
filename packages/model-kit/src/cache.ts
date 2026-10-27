import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { CatalogResponse } from './types.js';

// Read the on-disk catalog cache. Returns null when absent or unreadable.
export function readCache(path: string): CatalogResponse | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CatalogResponse;
    if (!Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Write the catalog cache with 0600 permissions (contains plaintext keys).
export function writeCache(path: string, data: CatalogResponse): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  // Ensure mode even if the file already existed with broader permissions.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort; some platforms may not allow chmod.
  }
}
