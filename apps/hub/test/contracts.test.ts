import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

// ajv-formats is compiled to CJS with the plugin under .default; resolve it
// through createRequire so both NodeNext types and runtime line up.
const require = createRequire(import.meta.url);
const addFormats = (require('ajv-formats') as { default: FormatsPlugin }).default;
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '..', '..', '..', 'contracts');

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(contractsDir, 'schemas', name), 'utf8'),
  ) as Record<string, unknown>;
}
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(contractsDir, 'fixtures', name), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(loadSchema('common.json'));
ajv.addSchema(loadSchema('models-response.json'));
ajv.addSchema(loadSchema('usage-request.json'));
ajv.addSchema(loadSchema('health-check-request.json'));

function getValidator(id: string) {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`schema not registered: ${id}`);
  return validate;
}

const SCHEMA_IDS = {
  models: 'https://model-hub.local/schemas/models-response.json',
  usage: 'https://model-hub.local/schemas/usage-request.json',
  health: 'https://model-hub.local/schemas/health-check-request.json',
};

describe('contract fixtures validate against their schemas', () => {
  it('accepts the models-response fixture', () => {
    const validate = getValidator(SCHEMA_IDS.models);
    const fixture = loadFixture('models-response.example.json');
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts the usage-request fixture', () => {
    const validate = getValidator(SCHEMA_IDS.usage);
    const fixture = loadFixture('usage-request.example.json');
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts the health-check-request fixture', () => {
    const validate = getValidator(SCHEMA_IDS.health);
    const fixture = loadFixture('health-check-request.example.json');
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a tampered models fixture (missing required field)', () => {
    const validate = getValidator(SCHEMA_IDS.models);
    const fixture = loadFixture('models-response.example.json') as {
      models: unknown[];
    };
    // Every model must carry an api_key; remove it from the first entry.
    const broken = {
      ...fixture,
      models: [
        { ...(fixture.models[0] as Record<string, unknown>), api_key: undefined },
      ],
    };
    expect(validate(broken)).toBe(false);
  });

  it('rejects an out-of-range usage http_status', () => {
    const validate = getValidator(SCHEMA_IDS.usage);
    const fixture = loadFixture('usage-request.example.json') as Record<
      string,
      unknown
    >;
    const broken = { ...fixture, http_status: 999 };
    expect(validate(broken)).toBe(false);
  });
});
