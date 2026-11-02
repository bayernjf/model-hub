// Cooldown policy for quota-exhausted provider keys (design §5.1).
//
//   { kind: 'hours',   hours: 5 }                    -> now + N hours (default)
//   { kind: 'weekly',  weekday: 1, time: '00:00' }   -> next weekday (Mon=1..Sun=7)
//   { kind: 'monthly', dayOfMonth: 1, time: '00:00' }-> next day-of-month (clamped)
//
// Returns an ISO timestamp strictly in the future. The computed value is a
// soft retry horizon, not a billing-accurate reset.

export type CooldownPolicy =
  | { kind: 'hours'; hours?: number }
  | { kind: 'weekly'; weekday?: number; time?: string }
  | { kind: 'monthly'; dayOfMonth?: number; time?: string };

/** Normalized form: every field present so downstream math is null-safe. */
export type NormalizedCooldownPolicy =
  | { kind: 'hours'; hours: number }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'monthly'; dayOfMonth: number; time: string };

export const DEFAULT_COOLDOWN_POLICY = {
  kind: 'hours',
  hours: 5,
} as const;

export function normalizePolicy(raw: unknown): NormalizedCooldownPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COOLDOWN_POLICY };
  const p = raw as Record<string, unknown>;
  if (p.kind === 'weekly') {
    const weekday = clampInt(p.weekday, 1, 7) ?? 1;
    return { kind: 'weekly', weekday, time: parseTime(p.time) ?? '00:00' };
  }
  if (p.kind === 'monthly') {
    const dayOfMonth = clampInt(p.dayOfMonth, 1, 31) ?? 1;
    return { kind: 'monthly', dayOfMonth, time: parseTime(p.time) ?? '00:00' };
  }
  const hours = clampInt(p.hours, 1, 24 * 30) ?? DEFAULT_COOLDOWN_POLICY.hours;
  return { kind: 'hours', hours };
}

export function policyJson(raw: unknown): string {
  return JSON.stringify(normalizePolicy(raw));
}

// Compute the cooled-until ISO timestamp for a key that just hit its quota.
export function computeCooledUntil(policy: unknown, now: Date = new Date()): string {
  const p = normalizePolicy(policy);
  if (p.kind === 'hours') {
    return new Date(now.getTime() + p.hours * 3_600_000).toISOString();
  }
  const [hh, mm] = (p.time ?? '00:00').split(':').map((n) => Number(n));
  if (p.kind === 'weekly') {
    const result = new Date(now);
    result.setHours(hh || 0, mm || 0, 0, 0);
    const currentMonday1 = mondayOneBased(result.getDay()); // 1..7 (Mon=1)
    let delta = p.weekday - currentMonday1;
    if (delta < 0 || (delta === 0 && result.getTime() <= now.getTime())) delta += 7;
    result.setDate(result.getDate() + delta);
    return result.toISOString();
  }
  // monthly: next occurrence of day-of-month at time; clamp to month length.
  const result = new Date(now);
  result.setHours(hh || 0, mm || 0, 0, 0);
  let year = result.getFullYear();
  let month = result.getMonth(); // 0-based
  const lastDay = daysInMonth(year, month + 1);
  const targetDay = Math.min(p.dayOfMonth, lastDay);
  result.setDate(targetDay);
  if (result.getTime() <= now.getTime()) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    result.setFullYear(year, month, 1);
    result.setDate(Math.min(p.dayOfMonth, daysInMonth(year, month + 1)));
    result.setHours(hh || 0, mm || 0, 0, 0);
  }
  return result.toISOString();
}

function mondayOneBased(sundayZero: number): number {
  return sundayZero === 0 ? 7 : sundayZero;
}

function daysInMonth(year: number, monthOneBased: number): number {
  return new Date(year, monthOneBased, 0).getDate();
}

function clampInt(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

function parseTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
