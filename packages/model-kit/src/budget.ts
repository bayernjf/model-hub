// Cost governance primitives (PRD F6 / W5-1, W5-2).
//
// The hub is a control plane and never sees inference traffic, so budget
// enforcement lives here on the project side: before an alias call the kit
// compares the alias's UTC-day spend (from GET /pub/v1/usage/summary)
// against its daily_budget_micros and either reroutes to a fallback
// assignment or fails closed with BudgetExceededError.
import type {
  DegradationInfo,
  ProjectedModel,
  ResolvedModel,
  UsageSummary,
} from './types.js';
import { toResolved } from './resolve.js';

export interface BudgetState {
  alias: string;
  assignmentId: string;
  /** Builtin spend of the current UTC day, as last reported by the hub. */
  spentMicros: number;
  dailyBudgetMicros: number | null;
  percentUsed: number | null;
  /** True when spent >= budget. Always false without a configured budget. */
  exceeded: boolean;
}

export class BudgetStateError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BudgetStateError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';

  constructor(
    readonly alias: string,
    readonly spentMicros: number,
    readonly dailyBudgetMicros: number,
  ) {
    super(
      `BUDGET_EXCEEDED: alias '${alias}' spent ${spentMicros} of ${dailyBudgetMicros} micros today and no fallback with remaining budget is available`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** GET /pub/v1/usage/summary with the project token. Throws on HTTP errors. */
export async function fetchUsageSummary(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<UsageSummary> {
  const res = await fetchImpl(
    `${hubUrl.replace(/\/+$/, '')}/pub/v1/usage/summary`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new BudgetStateError(`hub returned ${res.status}`, res.status);
  }
  const data = (await res.json()) as UsageSummary;
  if (!data || !Array.isArray(data.models)) {
    throw new BudgetStateError('unexpected usage summary payload');
  }
  return data;
}

/**
 * Whether the budget layer runs at all. The explicit option wins; otherwise
 * the env kill switch decides (MODEL_KIT_BUDGET_ENFORCEMENT=off disables).
 */
export function isBudgetEnforcementEnabled(
  explicit?: 'on' | 'off' | undefined,
): boolean {
  if (explicit) return explicit === 'on';
  return process.env.MODEL_KIT_BUDGET_ENFORCEMENT !== 'off';
}

// Budget state for one alias, joining the catalog projection (limits) with
// the hub summary (spend). Returns null when the alias has no hub assignment
// (BYOK / env aliases are not governed).
export function budgetStateFor(
  models: ProjectedModel[],
  summary: UsageSummary | null,
  alias: string,
): BudgetState | null {
  const assignment = models.find((m) => m.alias === alias);
  if (!assignment) return null;
  const summaryModels = Array.isArray(summary?.models) ? summary.models : [];
  const spent =
    summaryModels.find((s) => s.assignment_id === assignment.assignment_id)
      ?.spent_micros ?? 0;
  const budget = assignment.daily_budget_micros;
  return {
    alias,
    assignmentId: assignment.assignment_id,
    spentMicros: spent,
    dailyBudgetMicros: budget,
    percentUsed:
      budget !== null && budget > 0
        ? Math.round((spent / budget) * 10000) / 100
        : null,
    exceeded: budget !== null && spent >= budget,
  };
}

function assignmentOverBudget(
  models: ProjectedModel[],
  summary: UsageSummary | null,
  assignmentId: string,
): boolean {
  const assignment = models.find((m) => m.assignment_id === assignmentId);
  if (!assignment || assignment.daily_budget_micros === null) return false;
  const summaryModels = Array.isArray(summary?.models) ? summary.models : [];
  const spent =
    summaryModels.find((s) => s.assignment_id === assignmentId)
      ?.spent_micros ?? 0;
  return spent >= (assignment.daily_budget_micros ?? 0);
}

/**
 * Pre-call budget check (W5-2). Resolves the alias with the normal order
 * (BYOK -> hub -> env); only hub models with a configured daily budget are
 * governed. When the resolved assignment is over budget:
 *
 * - a role=fallback assignment serving the same modality with remaining
 *   budget receives the call, and the result is flagged degraded so usage
 *   and the call result stay attributable (FR6-2);
 * - with no such fallback the call fails closed with BudgetExceededError —
 *   never a silent downgrade to unlimited spend.
 *
 * The spend snapshot is the last /pub/v1/usage/summary pull, so it can lag
 * the hub ledger by up to the refresh interval (default 5 minutes) plus
 * report latency.
 */
export function pickModelForCall(
  models: ProjectedModel[],
  summary: UsageSummary | null,
  alias: string,
  modality: string,
  resolveAlias: (alias: string) => ResolvedModel,
): { model: ResolvedModel; degraded: DegradationInfo | null } {
  const model = resolveAlias(alias);

  // BYOK spends the user's own money and env fallbacks predate budgets;
  // neither is governed.
  if (model.source !== 'hub' || model.dailyBudgetMicros == null) {
    return { model, degraded: null };
  }

  const state = budgetStateFor(models, summary, alias);
  if (!state?.exceeded) return { model, degraded: null };

  const fallback = models.find(
    (m) =>
      m.role === 'fallback' &&
      m.assignment_id !== model.assignmentId &&
      m.modalities.includes(modality) &&
      !assignmentOverBudget(models, summary, m.assignment_id),
  );
  if (fallback) {
    return {
      model: toResolved(fallback),
      degraded: { reason: 'budget_exceeded', requestedAlias: alias },
    };
  }

  throw new BudgetExceededError(
    alias,
    state.spentMicros,
    model.dailyBudgetMicros,
  );
}
