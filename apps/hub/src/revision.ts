import type { DatabaseSync } from 'node:sqlite';

const REVISION_KEY = 'catalog_revision';

// Monotonic catalog revision. Every write that changes providers, models,
// or assignments bumps it; the project-facing API uses it for ETag/304.
export class RevisionService {
  constructor(private readonly db: DatabaseSync) {}

  current(): number {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(REVISION_KEY) as { value: string } | undefined;
    return row ? Number(row.value) : 1;
  }

  bump(): number {
    const next = this.current() + 1;
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(REVISION_KEY, String(next));
    return next;
  }
}
