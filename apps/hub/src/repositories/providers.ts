import type { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt } from '../crypto/envelope.js';
import { isMasked, maskSecret } from '../crypto/mask.js';
import type { KeyRing } from '../crypto/keyring.js';
import { newId, nowIso } from '../ids.js';

interface ProviderRow {
  id: string;
  name: string;
  preset_id: string | null;
  protocol: string;
  base_url: string;
  billing_type: string;
  api_key_cipher: string | null;
  api_key_hint: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// Shape returned to clients: never includes the cipher.
export interface ProviderView {
  id: string;
  name: string;
  preset_id: string | null;
  protocol: string;
  base_url: string;
  billing_type: string;
  api_key_hint: string | null;
  has_api_key: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProviderCreate {
  name: string;
  protocol: string;
  base_url: string;
  preset_id?: string;
  billing_type?: string;
  api_key?: string;
  enabled?: boolean;
}

export interface ProviderUpdate {
  name?: string;
  protocol?: string;
  base_url?: string;
  preset_id?: string;
  billing_type?: string;
  api_key?: string;
  enabled?: boolean;
}

function toView(row: ProviderRow): ProviderView {
  return {
    id: row.id,
    name: row.name,
    preset_id: row.preset_id,
    protocol: row.protocol,
    base_url: row.base_url,
    billing_type: row.billing_type,
    api_key_hint: row.api_key_hint,
    has_api_key: row.api_key_cipher !== null,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ProviderRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ring: KeyRing,
  ) {}

  private rowById(id: string): ProviderRow | null {
    const row = this.db
      .prepare('SELECT * FROM providers WHERE id = ?')
      .get(id) as ProviderRow | undefined;
    return row ?? null;
  }

  list(): ProviderView[] {
    const rows = this.db
      .prepare('SELECT * FROM providers ORDER BY created_at, id')
      .all() as unknown as ProviderRow[];
    return rows.map(toView);
  }

  get(id: string): ProviderView | null {
    const row = this.rowById(id);
    return row ? toView(row) : null;
  }

  create(input: ProviderCreate): ProviderView {
    const now = nowIso();
    const id = newId('prov');

    let cipher: string | null = null;
    let hint: string | null = null;
    if (input.api_key) {
      cipher = encrypt(input.api_key, this.ring);
      hint = maskSecret(input.api_key);
    }

    this.db
      .prepare(
        `INSERT INTO providers
           (id, name, preset_id, protocol, base_url, billing_type,
            api_key_cipher, api_key_hint, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.preset_id ?? null,
        input.protocol,
        input.base_url,
        input.billing_type ?? 'payg',
        cipher,
        hint,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    return this.get(id) as ProviderView;
  }

  update(id: string, patch: ProviderUpdate): ProviderView | null {
    const existing = this.rowById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.name !== undefined) assign('name', patch.name);
    if (patch.protocol !== undefined) assign('protocol', patch.protocol);
    if (patch.base_url !== undefined) assign('base_url', patch.base_url);
    if (patch.preset_id !== undefined) assign('preset_id', patch.preset_id);
    if (patch.billing_type !== undefined)
      assign('billing_type', patch.billing_type);
    if (patch.enabled !== undefined)
      assign('enabled', patch.enabled ? 1 : 0);

    // api_key round-trip: undefined leaves it; empty or masked leaves it;
    // any other non-masked value re-seals the secret.
    if (
      patch.api_key !== undefined &&
      patch.api_key !== '' &&
      !isMasked(patch.api_key)
    ) {
      assign('api_key_cipher', encrypt(patch.api_key, this.ring));
      assign('api_key_hint', maskSecret(patch.api_key));
    }

    if (sets.length === 0) return toView(existing);

    sets.push('updated_at = ?');
    values.push(nowIso());
    values.push(id);

    this.db
      .prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(values as never[]));

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // Decrypt the stored API key (used by connection tests); null when absent.
  revealKey(id: string): string | null {
    const row = this.rowById(id);
    if (!row || !row.api_key_cipher) return null;
    return decrypt(row.api_key_cipher, this.ring);
  }
}
