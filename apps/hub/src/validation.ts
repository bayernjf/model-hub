// Lightweight server-side input validation for admin endpoints. W2-2 replaces
// the overlay/model validation with zod strict schemas; these baseline
// validators cover providers and projects.

export class ValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

const PROTOCOLS = ['openai-compatible', 'anthropic', 'gemini'];
const BILLING_TYPES = ['payg', 'subscription'];

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('body', 'request body must be an object');
  }
  return body as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(field, `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(field, `${field} must be <= ${maxLength} chars`);
  }
  return trimmed;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(field, `${field} must be a string`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(field, `${field} must be <= ${maxLength} chars`);
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(field, `${field} must be a boolean`);
  }
  return value;
}

export interface ValidatedProviderCreate {
  name: string;
  protocol: string;
  base_url: string;
  preset_id?: string;
  billing_type?: string;
  api_key?: string;
  enabled?: boolean;
}

function validateProviderFields(
  body: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (!partial || body.name !== undefined)
    out.name = requiredString(body, 'name', 100);
  if (!partial || body.protocol !== undefined) {
    const protocol = requiredString(body, 'protocol', 40);
    if (!PROTOCOLS.includes(protocol)) {
      throw new ValidationError(
        'protocol',
        `protocol must be one of ${PROTOCOLS.join(', ')}`,
      );
    }
    out.protocol = protocol;
  }
  if (!partial || body.base_url !== undefined) {
    const baseUrl = requiredString(body, 'base_url', 300);
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error();
      }
    } catch {
      throw new ValidationError('base_url', 'base_url must be a valid http(s) URL');
    }
    out.base_url = baseUrl;
  }
  if (body.preset_id !== undefined)
    out.preset_id = optionalString(body, 'preset_id', 60);
  if (body.billing_type !== undefined) {
    const billingType = optionalString(body, 'billing_type', 20);
    if (billingType !== undefined && !BILLING_TYPES.includes(billingType)) {
      throw new ValidationError(
        'billing_type',
        `billing_type must be one of ${BILLING_TYPES.join(', ')}`,
      );
    }
    out.billing_type = billingType;
  }
  if (body.api_key !== undefined)
    out.api_key = optionalString(body, 'api_key', 300);
  if (body.enabled !== undefined)
    out.enabled = optionalBoolean(body, 'enabled');

  return out;
}

export function validateProviderCreate(body: unknown): ValidatedProviderCreate {
  return validateProviderFields(asRecord(body), false) as unknown as ValidatedProviderCreate;
}

export function validateProviderUpdate(body: unknown): Record<string, unknown> {
  return validateProviderFields(asRecord(body), true);
}

export interface ValidatedProjectCreate {
  slug: string;
  display_name: string;
  enabled?: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

function validateProjectFields(
  body: Record<string, unknown>,
  partial: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (!partial || body.slug !== undefined) {
    const slug = requiredString(body, 'slug', 64);
    if (!SLUG_RE.test(slug)) {
      throw new ValidationError(
        'slug',
        'slug must be lowercase letters, digits, _ or -',
      );
    }
    out.slug = slug;
  }
  if (!partial || body.display_name !== undefined)
    out.display_name = requiredString(body, 'display_name', 100);
  if (body.enabled !== undefined)
    out.enabled = optionalBoolean(body, 'enabled');

  return out;
}

export function validateProjectCreate(body: unknown): ValidatedProjectCreate {
  return validateProjectFields(asRecord(body), false) as unknown as ValidatedProjectCreate;
}

export function validateProjectUpdate(body: unknown): Record<string, unknown> {
  return validateProjectFields(asRecord(body), true);
}
