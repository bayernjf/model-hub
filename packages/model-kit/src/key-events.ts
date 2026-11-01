// Best-effort provider key event reporting (design §5). When model-kit hits a
// quota-class 429 it rotates within the request and tells the hub to cool the
// spent key. Never blocks or throws into the caller (mirrors postUsage).

export interface KeyEventInput {
  keyId: string;
  kind: 'quota_exhausted' | 'recovered';
  code?: string | undefined;
  at?: string | undefined;
}

export async function postKeyEvent(
  hubUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  input: KeyEventInput,
): Promise<void> {
  try {
    await fetchImpl(`${hubUrl.replace(/\/+$/, '')}/pub/v1/key-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        key_id: input.keyId,
        kind: input.kind,
        code: input.code ?? null,
        at: input.at ?? new Date().toISOString(),
      }),
    });
  } catch {
    // reporting must not affect the workflow
  }
}
