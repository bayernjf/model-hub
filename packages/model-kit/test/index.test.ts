import { describe, expect, it } from 'vitest';
import { KIT_VERSION, MODALITIES, isModality } from '../src/index.js';

describe('model-kit baseline', () => {
  it('exports the five supported modalities', () => {
    expect([...MODALITIES]).toEqual([
      'text',
      'image',
      'video',
      'audio',
      'embedding',
    ]);
  });

  it('narrows known modality values and rejects unknown ones', () => {
    expect(isModality('text')).toBe(true);
    expect(isModality('embedding')).toBe(true);
    expect(isModality('nope')).toBe(false);
  });

  it('exposes the kit version', () => {
    expect(KIT_VERSION).toBe('0.1.0');
  });
});
