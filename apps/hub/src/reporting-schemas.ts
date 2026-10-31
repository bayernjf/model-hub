import { z } from 'zod';

const nonnegInt = z.number().int().nonnegative();
const assignmentId = z
  .string()
  .regex(/^asn_[a-zA-Z0-9_]+$/)
  .nullable();

// Mirrors contracts/schemas/usage-request.json. The `project` field is
// required by the contract but the authenticated token is authoritative.
export const UsageReportSchema = z
  .object({
    project: z.string().min(1),
    feature: z.string().min(1),
    billing_source: z.enum(['builtin', 'byok']),
    billing_type: z.enum(['payg', 'subscription']).optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    assignment_id: assignmentId.optional(),
    input_tokens: nonnegInt.optional(),
    output_tokens: nonnegInt.optional(),
    cache_read_tokens: nonnegInt.optional(),
    reasoning_tokens: nonnegInt.nullable().optional(),
    quantity: z.number().nonnegative().nullable().optional(),
    http_status: z.number().int().min(100).max(599),
    cached: z.boolean(),
    // True when the kit rerouted the call to a fallback after the requested
    // primary crossed its daily budget (FR6-2). Older kit builds omit it.
    degraded: z.boolean().optional(),
    ts: z.string().datetime({ offset: true }),
  })
  .strict();

export type UsageReport = z.infer<typeof UsageReportSchema>;

// Mirrors contracts/schemas/health-check-request.json.
export const HealthCheckReportSchema = z
  .object({
    project: z.string().min(1),
    assignment_id: assignmentId.optional(),
    alias: z.string().min(1).nullable().optional(),
    level: z.enum(['L3', 'L4']),
    ok: z.boolean(),
    latency_ms: nonnegInt,
    error: z
      .object({
        code: z.string(),
        hint: z.string().optional(),
        detail: z.string().optional(),
      })
      .nullable()
      .optional(),
    ts: z.string().datetime({ offset: true }),
  })
  .strict();

export type HealthCheckReport = z.infer<typeof HealthCheckReportSchema>;

export function firstZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request';
}
