import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/open.js';
import { buildKeyRing } from '../src/crypto/keyring.js';
import { migrateUp } from '../src/db/migrate.js';
import {
  LastActiveKeyError,
  ProviderKeyRepository,
} from '../src/repositories/provider-keys.js';

function setup() {
  const db = openDatabase(':memory:');
  migrateUp(db);
  const ring = buildKeyRing('master-key-0123456789abcdef');
  const keys = new ProviderKeyRepository(db, ring);
  // Provider row with no pool keys yet and a NULL legacy cipher; pool rows are
  // created through ProviderKeyRepository.add (real envelope encryption).
  db.prepare(
    `INSERT INTO providers (id,name,protocol,base_url,api_key_cipher,api_key_hint,enabled,created_at,updated_at)
     VALUES ('prov_1','Ark','openai-compatible','https://x/v1',NULL,NULL,1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`,
  ).run();
  return { db, keys, ring };
}

describe('provider key repository', () => {
  it('adds encrypted keys, never returning plaintext or cipher in views', () => {
    const { db, keys } = setup();
    const view = keys.add('prov_1', '套餐A', 'ak-plaintext-1234');
    expect(view.api_key_hint).toBe('****1234');
    expect(view).not.toHaveProperty('api_key_cipher');
    const stored = db.prepare('SELECT api_key_cipher FROM provider_keys WHERE id=?').get(view.id) as { api_key_cipher: string };
    expect(stored.api_key_cipher).toMatch(/^enc\$/);
    expect(stored.api_key_cipher).not.toContain('plaintext');
  });

  it('assigns increasing seq and returns usable keys in order', () => {
    const { keys } = setup();
    keys.add('prov_1', 'A', 'ak-key-a');
    keys.add('prov_1', 'B', 'ak-key-b');
    const usable = keys.usableKeys('prov_1', '2026-12-31T00:00:00Z');
    expect(usable.map((k) => k.key)).toEqual(['ak-key-a', 'ak-key-b']);
  });

  it('rejects disabling or deleting the last active key', () => {
    const { keys } = setup();
    const only = keys.add('prov_1', 'A', 'ak-key-a');
    expect(() => keys.setActive(only.id, false)).toThrow(LastActiveKeyError);
    expect(() => keys.delete(only.id)).toThrow(LastActiveKeyError);
  });

  it('allows disabling a key when another active key remains', () => {
    const { keys } = setup();
    const a = keys.add('prov_1', 'A', 'ak-key-a');
    keys.add('prov_1', 'B', 'ak-key-b');
    keys.setActive(a.id, false);
    const usable = keys.usableKeys('prov_1', '2026-12-31T00:00:00Z');
    expect(usable.map((k) => k.keyId)).toEqual([keys.listForProvider('prov_1')[1]!.id]);
  });

  it('re-orders seq densely from the full id set', () => {
    const { keys } = setup();
    const a = keys.add('prov_1', 'A', 'ak-a');
    const b = keys.add('prov_1', 'B', 'ak-b');
    keys.reorder('prov_1', [b.id, a.id]);
    const usable = keys.usableKeys('prov_1', '2026-12-31T00:00:00Z');
    expect(usable.map((k) => k.key)).toEqual(['ak-b', 'ak-a']);
    expect(() => keys.reorder('prov_1', [a.id])).toThrow();
  });

  it('hides cooled keys until cooled_until passes, and recover clears state', () => {
    const { keys } = setup();
    const a = keys.add('prov_1', 'A', 'ak-a');
    keys.add('prov_1', 'B', 'ak-b');
    keys.markQuotaExhausted(a.id, 'QuotaExceeded', new Date('2026-11-02T00:00:00Z'));
    // default policy = 5 hours, so cooled until 05:00
    const during = keys.usableKeys('prov_1', '2026-11-02T03:00:00Z');
    expect(during.map((k) => k.key)).toEqual(['ak-b']);
    const after = keys.usableKeys('prov_1', '2026-11-02T06:00:00Z');
    expect(after.map((k) => k.key)).toEqual(['ak-a', 'ak-b']);

    const view = keys.get(a.id)!;
    expect(view.status).toBe('quota_exhausted');
    expect(view.last_error_code).toBe('QuotaExceeded');
    keys.recover(a.id);
    const recovered = keys.get(a.id)!;
    expect(recovered.status).toBe('ok');
    expect(recovered.cooled_until).toBeNull();
  });
});

describe('migration 014 backfill', () => {
  it('copies a legacy provider key into one pool row and skips empty keys', () => {
    // Seed a legacy-schema providers table (pre-014 columns), then run migrations.
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        base_url TEXT NOT NULL, billing_type TEXT NOT NULL DEFAULT 'payg',
        api_key_cipher TEXT, api_key_hint TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO providers (id,name,protocol,base_url,api_key_cipher,api_key_hint,enabled,created_at,updated_at)
      VALUES ('p_with','W','openai-compatible','u','enc$abc','****abc',1,'t','t'),
             ('p_none','N','openai-compatible','u2',NULL,NULL,1,'t','t');
    `);
    migrateUp(db);
    const rows = db
      .prepare('SELECT provider_id, seq, status, is_active, api_key_cipher FROM provider_keys ORDER BY provider_id')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider_id: 'p_with', seq: 0, status: 'ok', is_active: 1, api_key_cipher: 'enc$abc' });
    // cooldown column added with NULL default.
    const policy = db.prepare('SELECT key_cooldown_policy FROM providers WHERE id=?').get('p_with') as { key_cooldown_policy: string | null };
    expect(policy.key_cooldown_policy).toBeNull();
  });
});
