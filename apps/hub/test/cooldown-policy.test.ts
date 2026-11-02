import { describe, expect, it } from 'vitest';
import { computeCooledUntil, normalizePolicy } from '../src/cooldown-policy.js';

describe('cooldown policy', () => {
  it('defaults to a 5-hour horizon and parses hours', () => {
    const now = new Date('2026-11-02T00:00:00.000Z');
    expect(normalizePolicy(null)).toEqual({ kind: 'hours', hours: 5 });
    const until = new Date(computeCooledUntil({ kind: 'hours', hours: 3 }, now));
    expect(until.toISOString()).toBe('2026-11-02T03:00:00.000Z');
  });

  it('computes the next weekly reset (weekday + time), always in the future', () => {
    // 2026-11-02 is a Monday. Weekly policy weekday=1 (Mon) 00:00 -> next Monday.
    const monday = new Date('2026-11-02T10:00:00.000Z');
    const nextMon = new Date(computeCooledUntil({ kind: 'weekly', weekday: 1, time: '00:00' }, monday));
    expect([nextMon.getDay(), nextMon.getDate()]).toEqual([1, 9]);

    const wed = new Date(computeCooledUntil({ kind: 'weekly', weekday: 3, time: '08:30' }, monday));
    expect([wed.getFullYear(), wed.getMonth(), wed.getDate(), wed.getHours(), wed.getMinutes()]).toEqual([2026, 10, 4, 8, 30]);

    const same = new Date(computeCooledUntil({ kind: 'weekly', weekday: 1, time: '00:00' }, new Date('2026-11-02T01:00:00.000Z')));
    expect([same.getDay(), same.getDate()]).toEqual([1, 9]);
  });

  it('computes the next monthly reset and clamps to month length', () => {
    // Day 31 requested from November (30 days): clamped to Nov 30, which is
    // still in the future relative to Nov 2, so it resolves to Nov 30 local.
    const nov = new Date('2026-11-02T00:00:00.000Z');
    const until = new Date(computeCooledUntil({ kind: 'monthly', dayOfMonth: 31, time: '00:00' }, nov));
    expect([until.getFullYear(), until.getMonth(), until.getDate()]).toEqual([2026, 10, 30]);
    expect([until.getHours(), until.getMinutes()]).toEqual([0, 0]);

    // From Nov 30 the clamp date has passed -> next month, clamped to Dec 31.
    const rollover = new Date(computeCooledUntil({ kind: 'monthly', dayOfMonth: 31, time: '00:00' }, new Date('2026-11-30T12:00:00.000Z')));
    expect([rollover.getFullYear(), rollover.getMonth(), rollover.getDate()]).toEqual([2026, 11, 31]);

    const later = new Date(computeCooledUntil({ kind: 'monthly', dayOfMonth: 15, time: '12:00' }, nov));
    expect([later.getFullYear(), later.getMonth(), later.getDate()]).toEqual([2026, 10, 15]);
    expect(later.getHours()).toBe(12);

    const passed = new Date(computeCooledUntil({ kind: 'monthly', dayOfMonth: 1, time: '00:00' }, nov));
    expect([passed.getFullYear(), passed.getMonth(), passed.getDate()]).toEqual([2026, 11, 1]);
  });

  it('normalizes invalid input to safe defaults', () => {
    expect(normalizePolicy('x')).toEqual({ kind: 'hours', hours: 5 });
    expect(normalizePolicy(undefined)).toEqual({ kind: 'hours', hours: 5 });
    expect(normalizePolicy({ kind: 'weekly', weekday: 99, time: 'bad' })).toEqual({ kind: 'weekly', weekday: 7, time: '00:00' });
    // Out-of-range hours clamp to the 1h floor rather than defaulting.
    expect(normalizePolicy({ kind: 'hours', hours: 0 })).toEqual({ kind: 'hours', hours: 1 });
    expect(normalizePolicy({ kind: 'hours', hours: 9999 })).toEqual({ kind: 'hours', hours: 720 });
  });
});
