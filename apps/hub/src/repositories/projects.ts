import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { maskSecret } from '../crypto/mask.js';
import { newId, nowIso } from '../ids.js';

interface ProjectRow {
  id: string;
  slug: string;
  display_name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface TokenRow {
  id: string;
  project_id: string;
  token_hash: string;
  token_hint: string | null;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
}

export interface ProjectView {
  id: string;
  slug: string;
  display_name: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface TokenView {
  id: string;
  token_hint: string | null;
  enabled: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface ProjectDetail extends ProjectView {
  tokens: TokenView[];
}

export interface ProjectCreate {
  slug: string;
  display_name: string;
  enabled?: boolean;
}

export interface ProjectUpdate {
  display_name?: string;
  enabled?: boolean;
}

export class SlugConflictError extends Error {
  constructor(slug: string) {
    super(`project slug already exists: ${slug}`);
    this.name = 'SlugConflictError';
  }
}

function hashProjectToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Generate a project token: mh_ prefix plus 64 hex chars. The plaintext is
// returned once; only its SHA-256 hash is persisted.
export function generateProjectToken(): string {
  return `mh_${randomBytes(32).toString('hex')}`;
}

function toProjectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toTokenView(row: TokenRow): TokenView {
  return {
    id: row.id,
    token_hint: row.token_hint,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  private projectRow(id: string): ProjectRow | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ?? null;
  }

  private projectRowBySlug(slug: string): ProjectRow | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE slug = ?')
      .get(slug) as ProjectRow | undefined;
    return row ?? null;
  }

  private tokenRow(id: string): TokenRow | null {
    const row = this.db
      .prepare('SELECT * FROM tokens WHERE id = ?')
      .get(id) as TokenRow | undefined;
    return row ?? null;
  }

  list(): ProjectView[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY slug')
      .all() as unknown as ProjectRow[];
    return rows.map(toProjectView);
  }

  get(id: string): ProjectDetail | null {
    const row = this.projectRow(id);
    if (!row) return null;
    return { ...toProjectView(row), tokens: this.listTokens(id) };
  }

  getBySlug(slug: string): ProjectDetail | null {
    const row = this.projectRowBySlug(slug);
    if (!row) return null;
    return this.get(row.id);
  }

  create(input: ProjectCreate): ProjectDetail {
    if (this.projectRowBySlug(input.slug)) {
      throw new SlugConflictError(input.slug);
    }

    const now = nowIso();
    const id = newId('prj');
    this.db
      .prepare(
        `INSERT INTO projects (id, slug, display_name, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.slug,
        input.display_name,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    return this.get(id) as ProjectDetail;
  }

  update(id: string, patch: ProjectUpdate): ProjectDetail | null {
    const existing = this.projectRow(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.display_name !== undefined)
      assign('display_name', patch.display_name);
    if (patch.enabled !== undefined) assign('enabled', patch.enabled ? 1 : 0);

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(nowIso());
      values.push(id);
      this.db
        .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(values as never[]));
    }

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  listTokens(projectId: string): TokenView[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tokens WHERE project_id = ? ORDER BY created_at DESC',
      )
      .all(projectId) as unknown as TokenRow[];
    return rows.map(toTokenView);
  }

  // Mint a new token for a project. The plaintext is shown once.
  createToken(projectId: string): { token: string; view: TokenView } | null {
    if (!this.projectRow(projectId)) return null;

    const token = generateProjectToken();
    const id = newId('tok');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tokens
           (id, project_id, token_hash, token_hint, enabled, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        projectId,
        hashProjectToken(token),
        maskSecret(token),
        now,
      );

    return { token, view: toTokenView(this.tokenRow(id) as TokenRow) };
  }

  // Rotation mints a new token; existing enabled tokens are retained so the
  // project can switch over without downtime.
  rotateToken = this.createToken;

  setTokenEnabled(tokenId: string, enabled: boolean): boolean {
    const result = this.db
      .prepare('UPDATE tokens SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, tokenId);
    return Number(result.changes) > 0;
  }
}
