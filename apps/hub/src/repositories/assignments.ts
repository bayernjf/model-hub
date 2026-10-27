import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../ids.js';

interface AssignmentRow {
  id: string;
  project_id: string;
  model_id: string;
  role: string;
  alias: string | null;
  daily_budget_micros: number | null;
  created_at: string;
  updated_at: string;
}

export interface AssignmentView {
  id: string;
  project_id: string;
  model_id: string;
  role: string;
  alias: string | null;
  daily_budget_micros: number | null;
  created_at: string;
  updated_at: string;
}

export interface AssignmentInput {
  model_id: string;
  role?: string | undefined;
  alias?: string | null | undefined;
  daily_budget_micros?: number | null | undefined;
}

export class AssignmentValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssignmentValidationError';
  }
}

const ROLES = ['primary', 'fallback'] as const;

function toView(row: AssignmentRow): AssignmentView {
  return {
    id: row.id,
    project_id: row.project_id,
    model_id: row.model_id,
    role: row.role,
    alias: row.alias,
    daily_budget_micros: row.daily_budget_micros,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class AssignmentRepository {
  constructor(private readonly db: DatabaseSync) {}

  private projectExists(projectId: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as { id: string } | undefined;
    return row !== undefined;
  }

  private modelExists(modelId: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM model_overlays WHERE id = ?')
      .get(modelId) as { id: string } | undefined;
    return row !== undefined;
  }

  listByProject(projectId: string): AssignmentView[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM assignments WHERE project_id = ? ORDER BY created_at',
      )
      .all(projectId) as unknown as AssignmentRow[];
    return rows.map(toView);
  }

  listAll(): AssignmentView[] {
    const rows = this.db
      .prepare('SELECT * FROM assignments ORDER BY project_id, created_at')
      .all() as unknown as AssignmentRow[];
    return rows.map(toView);
  }

  // Replace every assignment for a project atomically. The whole batch is
  // validated before any write, then swapped inside a transaction.
  replaceForProject(
    projectId: string,
    inputs: AssignmentInput[],
  ): AssignmentView[] {
    if (!this.projectExists(projectId)) {
      throw new AssignmentValidationError('project_not_found', 'project not found');
    }

    const aliases = new Set<string>();
    const models = new Set<string>();
    for (const input of inputs) {
      if (!this.modelExists(input.model_id)) {
        throw new AssignmentValidationError(
          'model_not_found',
          `model not found: ${input.model_id}`,
        );
      }
      if (models.has(input.model_id)) {
        throw new AssignmentValidationError(
          'duplicate_model',
          `model assigned twice: ${input.model_id}`,
        );
      }
      models.add(input.model_id);

      const role = input.role ?? 'primary';
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new AssignmentValidationError(
          'invalid_role',
          `role must be one of ${ROLES.join(', ')}`,
        );
      }

      if (input.alias !== undefined && input.alias !== null) {
        const alias = input.alias.trim();
        if (alias.length === 0) {
          throw new AssignmentValidationError(
            'invalid_alias',
            'alias cannot be empty',
          );
        }
        if (aliases.has(alias)) {
          throw new AssignmentValidationError(
            'duplicate_alias',
            `alias used twice: ${alias}`,
          );
        }
        aliases.add(alias);
      }

      const budget = input.daily_budget_micros;
      if (budget !== undefined && budget !== null && budget < 0) {
        throw new AssignmentValidationError(
          'invalid_budget',
          'daily budget must be non-negative',
        );
      }
    }

    const insert = this.db.prepare(
      `INSERT INTO assignments
         (id, project_id, model_id, role, alias, daily_budget_micros,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const del = this.db.prepare('DELETE FROM assignments WHERE project_id = ?');

    this.db.exec('BEGIN');
    try {
      del.run(projectId);
      const now = nowIso();
      for (const input of inputs) {
        const alias =
          input.alias === undefined || input.alias === null
            ? null
            : input.alias.trim();
        insert.run(
          newId('asn'),
          projectId,
          input.model_id,
          input.role ?? 'primary',
          alias,
          input.daily_budget_micros ?? null,
          now,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.listByProject(projectId);
  }
}
