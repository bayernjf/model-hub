// model-kit public entry. M0 ships only the stable baseline; catalog
// pull/cache, resolution and drivers arrive in M3/M4.

export const KIT_VERSION = '0.1.0';

export const MODALITIES = [
  'text',
  'image',
  'video',
  'audio',
  'embedding',
] as const;

export type Modality = (typeof MODALITIES)[number];

export function isModality(value: string): value is Modality {
  return (MODALITIES as readonly string[]).includes(value);
}
