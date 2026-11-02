import { describe, expect, it } from 'vitest';
import { deriveSessionKey } from '../src/crypto/keyring.js';
import { ConfigError, loadConfig } from '../src/config.js';

const validSecrets = {
  HUB_MASTER_KEY: 'a'.repeat(32),
  HUB_ADMIN_PASSWORD: 'b'.repeat(16),
};

describe('loadConfig', () => {
  it('parses a valid production config', () => {
    const cfg = loadConfig({
      ...validSecrets,
      HUB_PORT: '9000',
      HUB_DATA_DIR: '/tmp/hub-data',
    });

    expect(cfg.port).toBe(9000);
    expect(cfg.dataDir).toBe('/tmp/hub-data');
    expect(cfg.devNoAuth).toBe(false);
    expect(cfg.masterKey).toBe(validSecrets.HUB_MASTER_KEY);
    // Sessions sign with a dedicated HKDF subkey, never the master key.
    expect(cfg.sessionKey).toBe(deriveSessionKey(validSecrets.HUB_MASTER_KEY));
    expect(cfg.sessionKey).not.toBe(validSecrets.HUB_MASTER_KEY);
  });

  it('applies defaults when port and data dir are omitted', () => {
    const cfg = loadConfig({ ...validSecrets });
    expect(cfg.port).toBe(8791);
    expect(cfg.dataDir).toBe('./data');
  });

  it('fails closed without a master key in production', () => {
    expect(() => loadConfig({ HUB_ADMIN_PASSWORD: 'b'.repeat(16) })).toThrow(
      ConfigError,
    );
  });

  it('fails closed without an admin password in production', () => {
    expect(() => loadConfig({ HUB_MASTER_KEY: 'a'.repeat(32) })).toThrow(
      ConfigError,
    );
  });

  it('rejects short secrets', () => {
    expect(() =>
      loadConfig({ HUB_MASTER_KEY: 'short', HUB_ADMIN_PASSWORD: 'b'.repeat(16) }),
    ).toThrow(ConfigError);
  });

  it('permits missing secrets with the dev switch', () => {
    const cfg = loadConfig({ HUB_DEV_NO_AUTH: '1' });
    expect(cfg.devNoAuth).toBe(true);
    expect(cfg.port).toBe(8791);
  });

  it('refuses to boot with the dev switch under NODE_ENV=production', () => {
    expect(() =>
      loadConfig({ ...validSecrets, NODE_ENV: 'production', HUB_DEV_NO_AUTH: '1' }),
    ).toThrow(/HUB_DEV_NO_AUTH.*forbidden.*production/s);
  });

  it('ignores the dev switch in production even with valid secrets present', () => {
    // The gate fires before any secret handling: no combination of otherwise
    // valid config can rescue a production boot carrying the dev switch.
    expect(() =>
      loadConfig({ ...validSecrets, NODE_ENV: 'production', HUB_DEV_NO_AUTH: '1' }),
    ).toThrow(ConfigError);
  });

  it('keeps the dev switch working outside production', () => {
    for (const nodeEnv of [undefined, 'development', 'test']) {
      const env: NodeJS.ProcessEnv = { HUB_DEV_NO_AUTH: '1' };
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      expect(loadConfig(env).devNoAuth).toBe(true);
    }
  });

  it('loads a production config normally when the dev switch is absent or 0', () => {
    expect(
      loadConfig({ ...validSecrets, NODE_ENV: 'production' }).devNoAuth,
    ).toBe(false);
    expect(
      loadConfig({ ...validSecrets, NODE_ENV: 'production', HUB_DEV_NO_AUTH: '0' })
        .devNoAuth,
    ).toBe(false);
  });

  it('rejects out-of-range and non-numeric ports', () => {
    expect(() => loadConfig({ ...validSecrets, HUB_PORT: '0' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...validSecrets, HUB_PORT: '70000' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...validSecrets, HUB_PORT: 'x' })).toThrow(
      ConfigError,
    );
  });
});
