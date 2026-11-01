#!/usr/bin/env node
/**
 * Copied from bayjf/console-ui by `node scripts/sync.mjs` — do not edit here.
 *
 * Verifies this repo's embedded token block matches the pinned tokens.lock.
 * Run `node ../console-ui/scripts/sync.mjs` to refresh both the block and the
 * lock when the canonical tokens change.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '/* @bayjf/console-ui:begin — generated from bayjf/console-ui; do not edit by hand */';
const END = '/* @bayjf/console-ui:end */';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = process.argv[2] ?? join(here, '../src/styles/tokens.css');
const lockPath = process.argv[3] ?? join(dirname(cssPath), 'tokens.lock');

const css = readFileSync(cssPath, 'utf8');
const start = css.indexOf(BEGIN);
const end = css.indexOf(END);
if (start < 0 || end < start) {
  console.error(`${cssPath}: missing @bayjf/console-ui markers — run the console-ui sync script`);
  process.exit(1);
}
const block = css.slice(start + BEGIN.length, end);
const normalized = block
  .split('\n')
  .map((line) => line.trimEnd())
  .join('\n')
  .trim();
const actual = createHash('sha256').update(normalized).digest('hex');
const expected = readFileSync(lockPath, 'utf8').trim();

if (actual !== expected) {
  console.error(
    `design tokens drifted from console-ui (${cssPath})\n  expected ${expected}\n  actual   ${actual}\n` +
      '  run `node ../console-ui/scripts/sync.mjs` and commit the result',
  );
  process.exit(1);
}
console.log(`tokens ok: ${cssPath}`);
