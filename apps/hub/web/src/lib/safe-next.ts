/**
 * Open-redirect guard for the login `?next=` value (review MH-4).
 *
 * Only a same-origin relative path is accepted: it must start with a single
 * "/" and must not be protocol-relative ("//") or the backslash form ("/\"),
 * both of which browsers normalize into a scheme-relative URL pointing at an
 * external host. Everything else (empty, absolute URL, any external form)
 * falls back to the caller's default in-console path.
 */
export function safeNextOr(next: string | null | undefined, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
