import { describe, expect, it } from 'vitest';
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
