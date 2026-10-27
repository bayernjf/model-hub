/**
 * Sliding-window rate limiter for connection tests. Mirrors the job-agent
 * /validate guard: at most `limit` hits per `windowMs` for a given key (an
 * IP/session), preventing credential probing abuse.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record a hit and return whether it is allowed. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Remaining allowed hits for a key (for status responses). */
  remaining(key: string, now: number = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    return Math.max(0, this.limit - recent.length);
  }
}
