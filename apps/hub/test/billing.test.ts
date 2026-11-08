import { describe, it, expect } from 'vitest';
import { buildStatement, periodBounds } from '../src/billing.js';
import type { CostAggregateRow } from '../src/repositories/reporting.js';
import { ValidationError } from '../src/validation.js';
import { login, makeTestApp } from './helpers.js';

function row(
  overrides: Partial<CostAggregateRow> & Pick<CostAggregateRow, 'project'>
): CostAggregateRow {
  return {
    day: '2026-11-15',
    billing_source: 'builtin',
    model: 'doubao-seed-1-6',
    calls: 1,
    input_tokens: 10,
    output_tokens: 20,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    quantity: 0,
    cost_micros: 100,
    ...overrides,
  };
}

describe('periodBounds', () => {
  it('resolves a month to a closed UTC interval', () => {
    expect(periodBounds('2026-11')).toEqual({
      period: '2026-11',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-30T23:59:59.999Z',
    });
  });

  it('handles February in a leap and a non-leap year', () => {
    expect(periodBounds('2024-02').to).toBe('2024-02-29T23:59:59.999Z');
    expect(periodBounds('2026-02').to).toBe('2026-02-28T23:59:59.999Z');
  });

  it('rejects months that cannot exist', () => {
    for (const bad of ['2026-13', '2026-00', '2026-1', '2026-11-01', 'abc', '']) {
      expect(() => periodBounds(bad)).toThrow(ValidationError);
    }
  });

  it('names the offending field so a 400 can point at it', () => {
    try {
      periodBounds('2026-13');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('period');
    }
  });
});

describe('buildStatement', () => {
  it('bills builtin and only meters byok', () => {
    const rows = [
      row({ project: 'zeus', cost_micros: 300 }),
      row({ project: 'zeus', cost_micros: 200 }),
      row({
        project: 'zeus',
        billing_source: 'byok',
        input_tokens: 500,
        output_tokens: 100,
        cost_micros: 4000,
      }),
    ];
    const statement = buildStatement(rows, '2026-11');

    expect(statement.billable.amount_micros).toBe(500);
    expect(statement.billable.calls).toBe(2);
    // byok money never passes through us, even though the row carries a cost.
    expect(statement.metered_only.amount_micros).toBe(0);
    expect(statement.metered_only.calls).toBe(1);
    expect(statement.metered_only.input_tokens).toBe(500);

    expect(statement.by_project).toHaveLength(1);
    expect(statement.by_project[0]).toMatchObject({
      project: 'zeus',
      billable_micros: 500,
      metered_tokens: 600,
      calls: 3,
    });
  });

  it('excludes rows from another month instead of silently billing them', () => {
    const rows = [
      row({ day: '2026-11-30', cost_micros: 100 }),
      row({ day: '2026-12-01', cost_micros: 999 }),
    ];
    const statement = buildStatement(rows, '2026-11');

    expect(statement.billable.amount_micros).toBe(100);
    expect(statement.excluded_rows).toBe(1);
  });

  it('treats a missing price as zero rather than NaN', () => {
    const rows = [row({ cost_micros: null as unknown as number })];
    const statement = buildStatement(rows, '2026-11');

    expect(statement.billable.calls).toBe(1);
    expect(statement.billable.amount_micros).toBe(0);
    expect(Number.isNaN(statement.billable.amount_micros)).toBe(false);
  });

  it('sorts project and model lines by billable amount', () => {
    const rows = [
      row({ project: 'cheap', model: 'a', cost_micros: 10 }),
      row({ project: 'dear', model: 'b', cost_micros: 900 }),
    ];
    const statement = buildStatement(rows, '2026-11');

    expect(statement.by_project.map((line) => line.project)).toEqual(['dear', 'cheap']);
    expect(statement.by_model.map((line) => line.model)).toEqual(['b', 'a']);
  });

  it('states the byok rule in the payload so a reader does not need the docs', () => {
    const statement = buildStatement([], '2026-11');
    expect(statement.note).toContain('byok');
    expect(statement.metered_only.amount_micros).toBe(0);
    expect(statement.currency).toBe('USD');
  });
});

describe('GET /api/admin/billing', () => {
  it('requires an admin session', async () => {
    const t = makeTestApp();
    const res = await t.app.request('/api/admin/billing?period=2026-11');
    expect(res.status).toBe(401);
  });

  it('answers an empty statement for a month with no usage', async () => {
    const t = makeTestApp();
    const cookie = await login(t.app);
    const res = await t.app.request('/api/admin/billing?period=2026-11', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      period: string;
      billable: { amount_micros: number; calls: number };
      by_project: unknown[];
    };
    expect(body.period).toBe('2026-11');
    expect(body.billable.amount_micros).toBe(0);
    expect(body.billable.calls).toBe(0);
    expect(body.by_project).toEqual([]);
  });

  it('rejects a malformed period with a field-addressed 400', async () => {
    const t = makeTestApp();
    const cookie = await login(t.app);
    const res = await t.app.request('/api/admin/billing?period=2026-13', { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { code: string; field: string } };
    expect(body.error.code).toBe('validation_error');
    expect(body.error.field).toBe('period');
  });

  it('defaults to the current UTC month', async () => {
    const t = makeTestApp();
    const cookie = await login(t.app);
    const res = await t.app.request('/api/admin/billing', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { period: string };
    expect(body.period).toBe(new Date().toISOString().slice(0, 7));
  });
});
