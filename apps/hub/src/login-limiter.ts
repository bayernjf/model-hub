/**
 * Persistent sliding-window login failure limiter. Semantics match the
 * in-memory SlidingWindowRateLimiter (at most `limit` failures per `windowMs`
 * for a key), but hits are stored in the login_attempts table so the budget
 * survives restarts and is shared across instances that open the same DB.
 *
 * Only failures are recorded via `allow`; `clear` is called on a successful
 * login so a locked-out IP recovers after one correct login.
 */
import type { DatabaseSync } from 'node:sqlite';

export class PersistentLoginLimiter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record one failed attempt and return whether it was accepted. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = this.load(key, now);
    if (recent.length >= this.limit) {
      return false;
    }
    recent.push(now);
    this.store(key, recent);
    return true;
  }

  /** Remaining allowed failures for a key (for pre-checks). */
  remaining(key: string, now: number = Date.now()): number {
    const recent = this.load(key, now);
    return Math.max(0, this.limit - recent.length);
  }

  /** Forget a key on a successful login. */
  clear(key: string): void {
    this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(key);
  }

  private load(key: string, now: number): number[] {
    const row = this.db
      .prepare('SELECT hits_json FROM login_attempts WHERE ip = ?')
      .get(key) as { hits_json: string } | undefined;
    if (!row) return [];
    let hits: number[] = [];
    try {
      hits = JSON.parse(row.hits_json) as number[];
      if (!Array.isArray(hits)) hits = [];
    } catch {
      hits = [];
    }
    return hits.filter((t) => now - t < this.windowMs);
  }

  private store(key: string, hits: number[]): void {
    this.db
      .prepare(
        `INSERT INTO login_attempts (ip, hits_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           hits_json = excluded.hits_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(hits), Date.now());
  }
}
