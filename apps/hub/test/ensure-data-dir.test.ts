import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDataDir,
  getDirMode,
} from '../src/storage/ensure-data-dir.js';

describe('ensureDataDir', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('creates a missing nested directory with 0700 mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-data-'));
    roots.push(root);
    const target = join(root, 'nested', 'data');

    ensureDataDir(target);

    expect(getDirMode(target)).toBe(0o700);
  });

  it('tightens an existing directory to 0700', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-data-'));
    roots.push(root);

    ensureDataDir(root);

    expect(getDirMode(root)).toBe(0o700);
  });
});
