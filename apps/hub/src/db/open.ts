import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// Load node:sqlite via createRequire so bundlers/test runners that predate
// this experimental module (and strip the node: prefix) leave it to the Node
// runtime instead of trying to resolve a bare "sqlite" import.
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

// Open (or create) the SQLite database file. The parent directory and the
// database file hold encrypted keys and sensitive data, so they are forced
// to owner-only 0700/0600 regardless of the process umask, and foreign-key
// enforcement is enabled.
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }

  const db = new sqlite.DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');

  if (path !== ':memory:') {
    chmodSync(path, 0o600);
  }

  return db;
}
