import { chmodSync, mkdirSync, statSync } from 'node:fs';

// Ensure the data directory exists and is owner-only (0700). It holds the
// SQLite database, encrypted key material and any cached projections, so it
// must never be group/world readable. Individual sensitive files are
// additionally written 0600.
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

export function getDirMode(dir: string): number {
  // Lower 12 bits carry the permission bits; return them as an octal number.
  return statSync(dir).mode & 0o777;
}
