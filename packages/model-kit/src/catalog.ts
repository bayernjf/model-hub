import type { CatalogResponse } from './types.js';

function joinUrl(hubUrl: string): string {
  return `${hubUrl.replace(/\/+$/, '')}/pub/v1/models`;
}

export interface PullOutcome {
  notModified: boolean;
  data?: CatalogResponse;
}

// Pull the catalog. Sends If-None-Match when a previous revision is known
// so the hub can answer 304. Network/HTTP errors throw / return empty.
export async function pullCatalog(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  previousRevision?: number,
): Promise<PullOutcome> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (previousRevision != null) {
    headers['If-None-Match'] = `"${previousRevision}"`;
  }

  const res = await fetchImpl(joinUrl(hubUrl), { headers });
  if (res.status === 304) {
    return { notModified: true };
  }
  if (!res.ok) {
    throw new CatalogPullError(`hub returned ${res.status}`, res.status);
  }
  const data = (await res.json()) as CatalogResponse;
  return { notModified: false, data };
}

export class CatalogPullError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CatalogPullError';
  }
}
