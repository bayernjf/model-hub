import { describe, it, expect } from 'vitest';
import {
  PRESET_CATALOG,
  listPresetProviders,
  getPresetProvider,
  getPresetModel,
  MODALITIES,
  type Modality,
} from '../src/presets/index.js';

describe('preset catalog', () => {
  it('has a version and sourcing note', () => {
    expect(PRESET_CATALOG.catalog_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PRESET_CATALOG.sourcing_note.length).toBeGreaterThan(0);
  });

  it('ships the six expected providers', () => {
    const ids = listPresetProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'ark-plan',
        'ark',
        'agnes',
        'anthropic',
        'openai',
        'openspeech',
      ]),
    );
  });

  it('gives every provider a valid protocol, base url and key label', () => {
    for (const provider of listPresetProviders()) {
      expect(['openai-compatible', 'anthropic', 'gemini']).toContain(
        provider.protocol,
      );
      expect(['payg', 'subscription']).toContain(provider.billing_type);
      expect(provider.default_base_url).toMatch(/^https:\/\//);
      expect(provider.key_label.length).toBeGreaterThan(0);
      expect(provider.models.length).toBeGreaterThan(0);
    }
  });

  it('uses unique catalog model ids and non-empty API model ids', () => {
    const ids: string[] = [];
    for (const provider of listPresetProviders()) {
      for (const model of provider.models) {
        ids.push(model.id);
        expect(model.model.length).toBeGreaterThan(0);
        expect(model.display_name.length).toBeGreaterThan(0);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only valid modalities and non-negative prices', () => {
    for (const provider of listPresetProviders()) {
      for (const model of provider.models) {
        expect(model.modalities.length).toBeGreaterThan(0);
        for (const modality of model.modalities) {
          expect(MODALITIES).toContain(modality);
        }
        for (const value of Object.values(model.pricing)) {
          expect(value === null || (typeof value === 'number' && value >= 0)).toBe(
            true,
          );
        }
      }
    }
  });

  it('covers all five modalities', () => {
    const covered = new Set<Modality>();
    for (const provider of listPresetProviders()) {
      for (const model of provider.models) {
        for (const modality of model.modalities) covered.add(modality);
      }
    }
    for (const modality of MODALITIES) expect(covered.has(modality)).toBe(true);
  });

  it('marks the key anchor models and their billing shape', () => {
    const arkCode = getPresetModel('ark-plan', 'ark-code-latest');
    expect(arkCode?.reasoning).toBe(true);
    expect(arkCode?.modalities).toEqual(['text']);

    const arkPlan = getPresetProvider('ark-plan');
    expect(arkPlan?.billing_type).toBe('subscription');

    expect(getPresetModel('ark', 'seedream-5-0-pro')?.modalities).toEqual([
      'image',
    ]);
    expect(getPresetModel('ark', 'seedance-2-5')?.modalities).toEqual([
      'video',
    ]);
  });

  it('declares a submit/poll adapter for async video models', () => {
    for (const provider of listPresetProviders()) {
      for (const model of provider.models) {
        if (model.modalities.includes('video')) {
          expect(model.adapter?.submit_path).toBeTruthy();
          expect(model.endpoints?.videos).toBeTruthy();
        }
      }
    }
  });

  it('declares x-api-key auth and resource ids for voice models', () => {
    const tts = getPresetModel('openspeech', 'seed-tts-2');
    expect(tts?.adapter?.auth_style).toBe('x-api-key');
    expect(tts?.adapter?.resource_id).toBe('seed-tts-2.0');
    expect(tts?.adapter?.submit_path).toBeTruthy();

    const asr = getPresetModel('openspeech', 'seed-asr-2-async');
    expect(asr?.adapter?.auth_style).toBe('x-api-key');
    expect(asr?.adapter?.resource_id).toBe('volc.seedasr.sauc.duration');

    const nostream = getPresetModel('openspeech', 'seed-asr-2-nostream');
    expect(nostream?.adapter?.nonstream).toBe(true);
  });
});
