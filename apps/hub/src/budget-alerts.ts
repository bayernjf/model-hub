/**
 * Budget watermark alerts (PRD F6 / FR6-3).
 *
 * Evaluated after every builtin usage report: when an assignment's UTC-day
 * builtin spend reaches 80% or 100% of its daily budget, a webhook is POSTed
 * once per (assignment, day, level). The webhook shape mirrors the
 * ops-console notify contract: a JSON body signed with an HMAC-SHA256
 * signature header over the raw bytes, plus a delivery id for
 * at-least-once consumers.
 *
 * Kill switch: with HUB_BUDGET_WEBHOOK_URL unset the whole alert layer is
 * skipped (no evaluation, no webhook). Delivery is fire-and-forget — alerts
 * are advisory and must never fail the usage report that triggered them.
 */
import { createHmac } from 'node:crypto';
import type { AssignmentRepository } from './repositories/assignments.js';
import type { ModelRepository } from './repositories/models.js';
import type {
  BudgetAlertRepository,
  UsageRepository,
} from './repositories/reporting.js';

export interface BudgetAlertWebhookConfig {
  url?: string;
  secret?: string;
}

/** Compute the signature header value for a raw body (ops-console shape). */
export function signBudgetAlertBody(
  secret: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

export interface BudgetAlertPayload {
  type: 'budget.threshold';
  /** Alert level as an integer percent (80 or 100). */
  level: 80 | 100;
  project: string;
  assignment_id: string;
  alias: string | null;
  model: string;
  /** UTC day (YYYY-MM-DD) the budget belongs to. */
  day: string;
  spent_micros: number;
  budget_micros: number;
  /** Spent/limit as a percent (>= 100 when over budget); null for a zero
   * budget with spend (the ratio is undefined — any spend is over). */
  percent: number | null;
  at: string;
}

export interface DeliverBudgetAlertDeps {
  config: BudgetAlertWebhookConfig;
  fetchImpl?: typeof fetch;
}

/** Fire-and-forget webhook delivery. Resolves to false when skipped/failed. */
export async function deliverBudgetAlert(
  deps: DeliverBudgetAlertDeps,
  payload: BudgetAlertPayload,
  deliveryId: string,
): Promise<boolean> {
  const url = deps.config.url;
  if (!url) return false;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-hub-event': 'budget.threshold',
    'x-hub-delivery-id': deliveryId,
  };
  if (deps.config.secret) {
    headers['x-hub-signature'] = signBudgetAlertBody(
      deps.config.secret,
      body,
    );
  }
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers,
      body,
    });
    return res.ok;
  } catch {
    // Advisory alert: network failures are swallowed, never rethrown.
    return false;
  }
}

export interface BudgetAlertEvaluatorDeps {
  config: BudgetAlertWebhookConfig;
  assignmentRepo: AssignmentRepository;
  modelRepo: ModelRepository;
  usageRepo: UsageRepository;
  alertRepo: BudgetAlertRepository;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface BudgetAlertTarget {
  projectId: string;
  projectSlug: string;
  /** The assignment whose spend just grew; the only one evaluated. */
  assignmentId: string;
}

export interface FiredBudgetAlert {
  level: '80' | '100';
  assignmentId: string;
  percent: number | null;
}

/**
 * Check the assignment that just received spend against its daily budget and
 * fire any newly crossed watermark (80% first, then 100%). The synchronous
 * part is deliberately cheap (two indexed SQLite reads); the webhook is sent
 * asynchronously. Never throws.
 */
export function evaluateBudgetWatermarks(
  deps: BudgetAlertEvaluatorDeps,
  target: BudgetAlertTarget,
): FiredBudgetAlert[] {
  // Kill switch: no webhook URL configured, no alert layer at all.
  if (!deps.config.url) return [];

  const now = (deps.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);

  const assignment = deps.assignmentRepo
    .listByProject(target.projectId)
    .find((a) => a.id === target.assignmentId);
  const budget = assignment?.daily_budget_micros;
  if (!assignment || budget === null || budget === undefined) return [];

  const model = deps.modelRepo.get(assignment.model_id);
  const spent = deps.usageRepo
    .spendTodayByAssignment(target.projectId)
    .find((row) => row.assignment_id === target.assignmentId)?.cost_micros ?? 0;
  // A zero budget means any spend is over; the ratio itself is undefined.
  const percent =
    budget > 0 ? Math.round((spent / budget) * 10000) / 100 : spent > 0 ? null : 0;

  const fired: FiredBudgetAlert[] = [];
  const levels: Array<'80' | '100'> = ['80', '100'];
  for (const level of levels) {
    const threshold = level === '80' ? 80 : 100;
    // percent === null means a zero-budget assignment with spend: any amount
    // is over, so both watermarks fire.
    const crossed = percent === null || percent >= threshold;
    if (!crossed) continue;
    const recorded = deps.alertRepo.recordOnce({
      project_id: target.projectId,
      assignment_id: target.assignmentId,
      day,
      level,
      spent_micros: spent,
      budget_micros: budget,
    });
    // Duplicate (already alerted today at this level): skip the webhook.
    if (!recorded) continue;

    fired.push({ level, assignmentId: target.assignmentId, percent });
    const payload: BudgetAlertPayload = {
      type: 'budget.threshold',
      level: threshold as 80 | 100,
      project: target.projectSlug,
      assignment_id: target.assignmentId,
      alias: assignment.alias,
      model: model?.model ?? assignment.model_id,
      day,
      spent_micros: spent,
      budget_micros: budget,
      percent,
      at: now.toISOString(),
    };
    void deliverBudgetAlert(deps, payload, recorded.id).catch(() => false);
  }
  return fired;
}
