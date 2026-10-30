import { describe, expect, it } from 'vitest';
import { safeNextOr } from '../src/lib/safe-next';

/**
 * MH-4 regression: the admin login page must never redirect off-origin via
 * the `next` query parameter.
 */
describe('safeNextOr', () => {
  const FALLBACK = '/providers';

  it('accepts same-origin relative paths', () => {
    expect(safeNextOr('/providers', FALLBACK)).toBe('/providers');
    expect(safeNextOr('/models?filter=enabled', FALLBACK)).toBe('/models?filter=enabled');
  });

  it('accepts the root path', () => {
    expect(safeNextOr('/', FALLBACK)).toBe('/');
  });

  it('falls back when next is missing or empty', () => {
    expect(safeNextOr(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextOr(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeNextOr('', FALLBACK)).toBe(FALLBACK);
  });

  it('rejects absolute URLs to other origins', () => {
    expect(safeNextOr('https://evil.example/grab', FALLBACK)).toBe(FALLBACK);
    expect(safeNextOr('http://evil.example', FALLBACK)).toBe(FALLBACK);
    expect(safeNextOr('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
  });

  it('rejects protocol-relative and backslash forms', () => {
    expect(safeNextOr('//evil.example/grab', FALLBACK)).toBe(FALLBACK);
    expect(safeNextOr('/\\evil.example/grab', FALLBACK)).toBe(FALLBACK);
    expect(safeNextOr('/\\\\evil.example', FALLBACK)).toBe(FALLBACK);
  });

  it('keeps paths with inner double slashes (still same-origin)', () => {
    // "/..//models" resolves to a path on the current origin; only "//" and
    // "/\" prefixes are scheme-relative traps.
    expect(safeNextOr('/..//models', FALLBACK)).toBe('/..//models');
  });
});
