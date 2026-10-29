// Shared fetch helper for islands. A 401 from the Hono API means the session
// is missing/expired; redirect to login, preserving the intended destination.
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    const next = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = `/login?next=${next}`;
    throw new Error('unauthorized');
  }
  return res;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function errorMessage(status: number, body: unknown): string {
  const err = (body as { error?: { code?: string; message?: string } }).error;
  return err?.message ?? `请求失败（HTTP ${status}）`;
}

// JSON fetch that treats non-OK responses as errors. Load paths previously
// assumed success and could hang on a spinner or render a misleading empty
// state when the API failed; callers now catch and show a retry banner.
export async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: { code?: string } }).error?.code ?? 'error', errorMessage(res.status, body));
  }
  return (await res.json()) as T;
}

// Extract a human-readable message from a thrown value for error banners.
export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return '加载失败';
}
