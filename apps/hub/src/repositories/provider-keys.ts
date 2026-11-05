import type { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt } from '../crypto/envelope.js';
import { maskSecret } from '../crypto/mask.js';
import type { KeyRing } from '../crypto/keyring.js';
import { newId, nowIso } from '../ids.js';
import { computeCooledUntil, normalizePolicy } from '../cooldown-policy.js';

interface ProviderKeyRow {
  id: string;
  provider_id: string;
  label: string;
  api_key_cipher: string;
  api_key_hint: string;
  is_active: number;
  status: string;
  cooled_until: string | null;
  last_error_code: string | null;
  last_failed_at: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

export type KeyStatus = 'ok' | 'quota_exhausted';

// Admin-facing view: never the cipher or plaintext.
export interface ProviderKeyView {
  id: string;
  provider_id: string;
  label: string;
  api_key_hint: string;
  is_active: boolean;
  status: KeyStatus;
  cooled_until: string | null;
  last_error_code: string | null;
  last_failed_at: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface UsableKey {
  keyId: string;
  label: string;
  key: string;
  seq: number;
}

function toView(row: ProviderKeyRow): ProviderKeyView {
  return {
    id: row.id,
    provider_id: row.provider_id,
    label: row.label,
    api_key_hint: row.api_key_hint,
    is_active: row.is_active === 1,
    status: row.status as KeyStatus,
    cooled_until: row.cooled_until,
    last_error_code: row.last_error_code,
    last_failed_at: row.last_failed_at,
    seq: row.seq,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class LastActiveKeyError extends Error {
  constructor() {
    super('cannot disable or delete the last active key');
    this.name = 'LastActiveKeyError';
  }
}

export class ProviderKeyRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ring: KeyRing,
  ) {}

  listForProvider(providerId: string): ProviderKeyView[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY seq, id')
      .all(providerId) as unknown as ProviderKeyRow[];
    return rows.map(toView);
  }

  private rowById(id: string): ProviderKeyRow | null {
    const row = this.db
      .prepare('SELECT * FROM provider_keys WHERE id = ?')
      .get(id) as ProviderKeyRow | undefined;
    return row ?? null;
  }

  get(id: string): ProviderKeyView | null {
    const row = this.rowById(id);
    return row ? toView(row) : null;
  }

  /** Decrypted key for one pool row (L1 per-key connection test). */
  revealKey(id: string): string | null {
    const row = this.rowById(id);
    return row ? decrypt(row.api_key_cipher, this.ring) : null;
  }

  add(providerId: string, label: string, apiKey: string): ProviderKeyView {
    const now = nowIso();
    this.db.exec('BEGIN');
    try {
      // A provider created after migration 014 keeps its first key in the
      // legacy providers column. When its first pool row is added, promote
      // that legacy cipher to pool seq=0 so ordering is [legacy, new] and the
      // original key stays manageable/disable-able (design §2 read/write parity).
      const existing = this.db
        .prepare('SELECT COUNT(*) AS n FROM provider_keys WHERE provider_id = ?')
        .get(providerId) as { n: number };
      if (existing.n === 0) {
        const legacy = this.db
          .prepare('SELECT api_key_cipher, api_key_hint, created_at FROM providers WHERE id = ?')
          .get(providerId) as
          | { api_key_cipher: string | null; api_key_hint: string | null; created_at: string }
          | undefined;
        if (legacy?.api_key_cipher) {
          this.db
            .prepare(
              `INSERT INTO provider_keys
                 (id, provider_id, label, api_key_cipher, api_key_hint, is_active,
                  status, cooled_until, last_error_code, last_failed_at, seq,
                  created_at, updated_at)
               VALUES (?, ?, '', ?, ?, 1, 'ok', NULL, NULL, NULL, 0, ?, ?)`,
            )
            .run(newId('pkey'), providerId, legacy.api_key_cipher, legacy.api_key_hint ?? '', legacy.created_at, now);
        }
      }

      const max = this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM provider_keys WHERE provider_id = ?')
        .get(providerId) as { m: number };
      const id = newId('pkey');
      this.db
        .prepare(
          `INSERT INTO provider_keys
             (id, provider_id, label, api_key_cipher, api_key_hint, is_active,
              status, cooled_until, last_error_code, last_failed_at, seq,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 'ok', NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          providerId,
          label,
          encrypt(apiKey, this.ring),
          maskSecret(apiKey),
          max.m + 1,
          now,
          now,
        );
      this.db.exec('COMMIT');
      return this.get(id) as ProviderKeyView;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Legacy `PATCH /api/admin/providers/:id { api_key }` compatibility. The
  // projection prefers the pool once it is non-empty, so updating only the
  // legacy provider column would silently not take effect. Mirror the re-sealed
  // key into the highest-priority row (seq=0) instead, creating that row when
  // the pool is still empty (provider created before its first pool add).
  // Replacing the credential also clears quota cooling: the new key has its
  // own quota, so a stale `quota_exhausted` state must not hide it.
  syncPrimaryKey(providerId: string, apiKey: string): ProviderKeyView {
    const now = nowIso();
    const cipher = encrypt(apiKey, this.ring);
    const hint = maskSecret(apiKey);
    const first = this.db
      .prepare(
        'SELECT id FROM provider_keys WHERE provider_id = ? ORDER BY seq, id LIMIT 1',
      )
      .get(providerId) as { id: string } | undefined;

    if (first) {
      this.db
        .prepare(
          `UPDATE provider_keys
             SET api_key_cipher = ?, api_key_hint = ?, status = 'ok',
                 cooled_until = NULL, last_error_code = NULL, last_failed_at = NULL,
                 updated_at = ?
           WHERE id = ?`,
        )
        .run(cipher, hint, now, first.id);
      return this.get(first.id) as ProviderKeyView;
    }

    const id = newId('pkey');
    this.db
      .prepare(
        `INSERT INTO provider_keys
           (id, provider_id, label, api_key_cipher, api_key_hint, is_active,
            status, cooled_until, last_error_code, last_failed_at, seq,
            created_at, updated_at)
         VALUES (?, ?, '', ?, ?, 1, 'ok', NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(id, providerId, cipher, hint, now, now);
    return this.get(id) as ProviderKeyView;
  }

  setActive(id: string, active: boolean): ProviderKeyView {
    if (!active) this.requireAnotherActive(id);
    this.db
      .prepare('UPDATE provider_keys SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(active ? 1 : 0, nowIso(), id);
    return this.get(id) as ProviderKeyView;
  }

  updateLabel(id: string, label: string): ProviderKeyView {
    this.db
      .prepare('UPDATE provider_keys SET label = ?, updated_at = ? WHERE id = ?')
      .run(label, nowIso(), id);
    return this.get(id) as ProviderKeyView;
  }

  // Move a key before/after its sibling; re-numbers seq densely 0..n-1.
  reorder(providerId: string, orderedIds: string[]): ProviderKeyView[] {
    const current = this.listForProvider(providerId);
    const byId = new Map(current.map((k) => [k.id, k]));
    if (
      orderedIds.length !== current.length ||
      !orderedIds.every((id) => byId.has(id))
    ) {
      throw new Error('reorder requires the full, current key id set');
    }
    const now = nowIso();
    const stmt = this.db.prepare(
      'UPDATE provider_keys SET seq = ?, updated_at = ? WHERE id = ? AND provider_id = ?',
    );
    this.db.exec('BEGIN');
    try {
      for (const [index, id] of orderedIds.entries()) {
        stmt.run(index, now, id, providerId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.listForProvider(providerId);
  }

  // Manual recovery: clear the cooldown regardless of policy.
  recover(id: string): ProviderKeyView {
    this.db
      .prepare(
        `UPDATE provider_keys
           SET status = 'ok', cooled_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), id);
    return this.get(id) as ProviderKeyView;
  }

  // Mark a key quota-exhausted using its provider's cooldown policy.
  markQuotaExhausted(
    id: string,
    errorCode: string | null,
    now: Date = new Date(),
  ): ProviderKeyView | null {
    const row = this.rowById(id);
    if (!row) return null;
    const policy = this.db
      .prepare('SELECT key_cooldown_policy AS p FROM providers WHERE id = ?')
      .get(row.provider_id) as { p: string | null } | undefined;
    const cooledUntil = computeCooledUntil(normalizePolicy(policy?.p ?? null), now);
    this.db
      .prepare(
        `UPDATE provider_keys
           SET status = 'quota_exhausted', cooled_until = ?,
               last_error_code = ?, last_failed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(cooledUntil, errorCode, now.toISOString(), now.toISOString(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    this.requireAnotherActive(id);
    const result = this.db.prepare('DELETE FROM provider_keys WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // Active, non-cooled keys in try order, decrypted. Empty when the provider
  // has no usable pool row; callers then fall back to the legacy key column.
  usableKeys(providerId: string, nowIsoTs: string): UsableKey[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_keys
          WHERE provider_id = ? AND is_active = 1
            AND (status = 'ok' OR cooled_until IS NULL OR cooled_until <= ?)
          ORDER BY seq, id`,
      )
      .all(providerId, nowIsoTs) as unknown as ProviderKeyRow[];
    return rows.map((row) => ({
      keyId: row.id,
      label: row.label,
      key: decrypt(row.api_key_cipher, this.ring),
      seq: row.seq,
    }));
  }

  countActive(providerId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM provider_keys WHERE provider_id = ? AND is_active = 1',
      )
      .get(providerId) as { n: number };
    return row.n;
  }

  private requireAnotherActive(id: string): void {
    const row = this.rowById(id);
    if (row && row.is_active === 1 && this.countActive(row.provider_id) <= 1) {
      throw new LastActiveKeyError();
    }
  }
}
