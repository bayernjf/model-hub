import { useCallback, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  CheckCircle2,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { apiFetch, apiJson, errorText } from './api';

export interface ProviderKey {
  id: string;
  provider_id: string;
  label: string;
  api_key_hint: string;
  is_active: boolean;
  status: 'ok' | 'quota_exhausted';
  cooled_until: string | null;
  last_error_code: string | null;
  seq: number;
}

type Policy =
  | { kind: 'hours'; hours: number }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'monthly'; dayOfMonth: number; time: string };

interface TestState {
  ok?: boolean;
  latency_ms?: number;
  errorCode?: string;
  hint?: string;
}

const POLICY_DEFAULT: Policy = { kind: 'hours', hours: 5 };

function parsePolicy(raw: string | null): Policy {
  try {
    const p = raw ? (JSON.parse(raw) as unknown) : POLICY_DEFAULT;
    if (p && typeof p === 'object' && 'kind' in p) return p as Policy;
  } catch {
    /* fall through */
  }
  return POLICY_DEFAULT;
}

function StatusBadge({ k }: { k: ProviderKey }) {
  if (k.status === 'quota_exhausted') {
    return (
      <span className="tag tag--fail" title={k.cooled_until ?? ''}>
        <XCircle size={11} /> 额度耗尽{k.cooled_until ? ` · 至 ${new Date(k.cooled_until).toLocaleString()}` : ''}
        {k.last_error_code ? ` (${k.last_error_code})` : ''}
      </span>
    );
  }
  return (
    <span className="tag tag--ok">
      <CheckCircle2 size={11} /> 正常
    </span>
  );
}

export default function KeyPool({
  providerId,
  initialPolicy,
}: {
  providerId: string;
  initialPolicy: string | null;
}) {
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [policy, setPolicy] = useState<Policy>(() => parsePolicy(initialPolicy));
  const [policySaved, setPolicySaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ keys: ProviderKey[] }>(
        `/api/admin/providers/${providerId}/keys`,
      );
      setKeys(data.keys.sort((a, b) => a.seq - b.seq));
      setLoadError(null);
      setLoaded(true);
    } catch (err) {
      // Keep any previously loaded rows; only annotate that they may be stale.
      setLoadError(errorText(err));
    }
  }, [providerId]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) await load();
  };

  const flashError = (message: string) => {
    setError(message);
    window.setTimeout(() => setError(null), 4000);
  };

  const runAction = async (id: string, fn: () => Promise<Response>, refresh = true): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; code?: string };
        };
        flashError(data.error?.message ?? data.error?.code ?? `操作失败（HTTP ${res.status}）`);
        return false;
      }
      if (refresh) await load();
      return true;
    } catch {
      // Transport failure: without this the busy flag never clears and every
      // action in the pool stays disabled for the rest of the session.
      flashError('网络异常，请重试：无法连接服务器。');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addKey = async () => {
    if (!newKey.trim()) {
      flashError('请填写 API Key');
      return;
    }
    const ok = await runAction('new', () =>
      apiFetch(`/api/admin/providers/${providerId}/keys`, {
        method: 'POST',
        body: JSON.stringify({ label: newLabel, api_key: newKey }),
      }),
    );
    if (ok) {
      setNewLabel('');
      setNewKey('');
    }
  };

  const reorder = async (orderedIds: string[]) => {
    // Optimistic order; server is source of truth after refresh.
    setKeys((prev) =>
      orderedIds
        .map((id) => prev.find((k) => k.id === id))
        .filter((k): k is ProviderKey => Boolean(k)),
    );
    await runAction('reorder', () =>
      apiFetch(`/api/admin/providers/${providerId}/keys/reorder`, {
        method: 'POST',
        body: JSON.stringify({ ordered_ids: orderedIds }),
      }),
    );
  };

  const move = (index: number, delta: number | 'top') => {
    const target = delta === 'top' ? 0 : index + delta;
    if (target < 0 || target >= keys.length || target === index) return;
    const next = keys.map((k) => k.id);
    const [id] = next.splice(index, 1);
    if (!id) return;
    next.splice(target, 0, id);
    void reorder(next);
  };

  const testKey = async (id: string) => {
    setBusy(`test-${id}`);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/admin/providers/${providerId}/keys/${id}/test`,
        { method: 'POST' },
      );
      const data = (await res.json().catch(() => null)) as
        | (TestState & { ok?: boolean; error?: { code?: string; hint?: string; message?: string } })
        | null;
      if (!res.ok || !data) {
        const hint = data?.error?.message ?? data?.error?.hint;
        setTests((prev) => ({
          ...prev,
          [id]: { ok: false, errorCode: `HTTP ${res.status}`, ...(hint ? { hint } : {}) },
        }));
        flashError(hint ?? `测试请求失败（HTTP ${res.status}）`);
      } else {
        const state: TestState = {
          ok: Boolean(data.ok),
          ...(typeof data.latency_ms === 'number' ? { latency_ms: data.latency_ms } : {}),
          ...(data.error?.code ? { errorCode: data.error.code } : {}),
          ...(data.error?.hint ? { hint: data.error.hint } : {}),
        };
        setTests((prev) => ({ ...prev, [id]: state }));
        await load(); // status may flip if quota was the failure
      }
    } catch {
      setTests((prev) => ({ ...prev, [id]: { ok: false, errorCode: 'network' } }));
      flashError('测试失败：网络异常，无法连接服务器。');
    } finally {
      setBusy(null);
    }
  };

  const activeCount = keys.filter((k) => k.is_active).length;

  const savePolicy = async () => {
    setBusy('policy');
    setError(null);
    try {
      const res = await apiFetch(
        `/api/admin/providers/${providerId}/cooldown-policy`,
        { method: 'PUT', body: JSON.stringify(policy) },
      );
      if (res.ok) {
        setPolicySaved(true);
        window.setTimeout(() => setPolicySaved(false), 2500);
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        flashError(data.error?.message ?? `冷却策略保存失败（HTTP ${res.status}）`);
      }
    } catch {
      flashError('网络异常：冷却策略未保存。');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="key-pool">
      <button className="btn btn--ghost" onClick={() => void toggle()} aria-expanded={open}>
        {open ? '收起密钥池' : `管理密钥池 (${keys.length || '…'})`}
      </button>

      {open && (
        <div className="panel" style={{ marginTop: 8 }}>
          {error && <div className="error" role="alert">{error}</div>}
          {loadError && (
            <div className="error" role="alert">
              密钥池加载失败：{loadError}（下方列表可能为空或过期）
              <button className="btn btn--ghost" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>顺序</th>
                <th>标签</th>
                <th>掩码</th>
                <th>状态</th>
                <th>L1 测试</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k, i) => {
                const t = tests[k.id];
                const lastActive = activeCount <= 1 && k.is_active;
                return (
                  <tr key={k.id}>
                    <td className="mono dim">{k.seq + 1}</td>
                    <td>{k.label || <span className="dim">（未命名）</span>}</td>
                    <td className="mono">{k.api_key_hint}</td>
                    <td><StatusBadge k={k} /></td>
                    <td>
                      {t ? (
                        t.ok ? (
                          <span className="tag tag--ok"><CheckCircle2 size={11} /> {t.latency_ms}ms</span>
                        ) : (
                          <span className="tag tag--fail" title={t.hint ?? ''}>
                            <XCircle size={11} /> {t.errorCode ?? 'fail'}
                          </span>
                        )
                      ) : (
                        <span className="tag">未测</span>
                      )}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={k.is_active}
                        disabled={lastActive}
                        aria-label={`启用 ${k.label || k.api_key_hint}`}
                        title={lastActive ? '至少保留一把启用的密钥' : ''}
                        onChange={(e) =>
                          void runAction(k.id, () =>
                            apiFetch(`/api/admin/providers/${providerId}/keys/${k.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ is_active: e.target.checked }),
                            }),
                          )
                        }
                      />
                    </td>
                    <td>
                      <span className="key-actions">
                        <button
                          className="icon-btn"
                          aria-label="置顶"
                          disabled={i === 0 || busy !== null}
                          onClick={() => move(i, 'top')}
                        >
                          <ArrowUpToLine size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label="上移"
                          disabled={i === 0 || busy !== null}
                          onClick={() => move(i, -1)}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label="下移"
                          disabled={i === keys.length - 1 || busy !== null}
                          onClick={() => move(i, 1)}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label="测试连接"
                          disabled={busy === `test-${k.id}`}
                          onClick={() => void testKey(k.id)}
                        >
                          {busy === `test-${k.id}` ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <CheckCircle2 size={13} />
                          )}
                        </button>
                        {k.status === 'quota_exhausted' && (
                          <button
                            className="icon-btn"
                            aria-label="标记恢复"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(k.id, () =>
                                apiFetch(
                                  `/api/admin/providers/${providerId}/keys/${k.id}/recover`,
                                  { method: 'POST' },
                                ),
                              )
                            }
                          >
                            <RotateCcw size={13} />
                          </button>
                        )}
                        <button
                          className="icon-btn icon-btn--danger"
                          aria-label="删除"
                          disabled={lastActive || busy !== null}
                          title={lastActive ? '至少保留一把启用的密钥' : ''}
                          onClick={() =>
                            void runAction(k.id, () =>
                              apiFetch(`/api/admin/providers/${providerId}/keys/${k.id}`, {
                                method: 'DELETE',
                              }),
                            )
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {loaded && keys.length === 0 && (
                <tr>
                  <td colSpan={7} className="dim">该厂商尚无密钥池，使用下方表单添加。</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="new-form key-add">
            <h4>添加备用密钥</h4>
            <label className="field">
              <span>标签（如：套餐B）</span>
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={80} />
            </label>
            <label className="field">
              <span>API Key（仅提交一次，之后只显示掩码）</span>
              <input
                type="password"
                value={newKey}
                autoComplete="off"
                onChange={(e) => setNewKey(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button
                className="btn btn--primary"
                disabled={busy === 'new'}
                onClick={() => void addKey()}
              >
                {busy === 'new' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} 添加
              </button>
            </div>
          </div>

          <div className="cooldown-policy">
            <h4>配额耗尽冷却策略</h4>
            <label className="field">
              <span>策略</span>
              <select
                value={policy.kind}
                onChange={(e) => {
                  const kind = e.target.value as Policy['kind'];
                  setPolicy(
                    kind === 'hours'
                      ? { kind, hours: 5 }
                      : kind === 'weekly'
                        ? { kind, weekday: 1, time: '00:00' }
                        : { kind, dayOfMonth: 1, time: '00:00' },
                  );
                }}
              >
                <option value="hours">固定小时数</option>
                <option value="weekly">每周重置</option>
                <option value="monthly">每月重置</option>
              </select>
            </label>

            {policy.kind === 'hours' && (
              <label className="field">
                <span>小时（1–720）</span>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={policy.hours}
                  onChange={(e) =>
                    setPolicy({ kind: 'hours', hours: Number(e.target.value) })
                  }
                />
              </label>
            )}
            {policy.kind === 'weekly' && (
              <>
                <label className="field">
                  <span>重置星期（1=周一 … 7=周日）</span>
                  <input
                    type="number"
                    min={1}
                    max={7}
                    value={policy.weekday}
                    onChange={(e) =>
                      setPolicy({ ...policy, weekday: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  <span>时刻（HH:MM）</span>
                  <input
                    type="time"
                    value={policy.time}
                    onChange={(e) => setPolicy({ ...policy, time: e.target.value })}
                  />
                </label>
              </>
            )}
            {policy.kind === 'monthly' && (
              <>
                <label className="field">
                  <span>重置日（1–31，月末自动 clamp）</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={policy.dayOfMonth}
                    onChange={(e) =>
                      setPolicy({ ...policy, dayOfMonth: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  <span>时刻（HH:MM）</span>
                  <input
                    type="time"
                    value={policy.time}
                    onChange={(e) => setPolicy({ ...policy, time: e.target.value })}
                  />
                </label>
              </>
            )}
            <div className="form-actions">
              <button
                className="btn btn--primary"
                disabled={busy === 'policy'}
                onClick={() => void savePolicy()}
              >
                {busy === 'policy' ? <Loader2 size={14} className="spin" /> : '保存策略'}
              </button>
              {policySaved && <span className="dim">已保存</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
