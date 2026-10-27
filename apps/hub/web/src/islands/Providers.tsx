import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Plus,
  XCircle,
} from 'lucide-react';
import { apiFetch, apiJson } from './api';
import type {
  Provider,
  PresetProvider,
  PresetsResponse,
  ConnectionTestResult as TestResult,
} from './types';

function TestBadge({ result }: { result: TestResult | undefined }) {
  if (!result) return <span className="tag">未测试</span>;
  if (result.ok) {
    return (
      <span className="tag tag--ok">
        <CheckCircle2 size={11} /> {result.latency_ms}ms
      </span>
    );
  }
  return (
    <span className="tag tag--fail" title={result.error?.hint ?? result.error?.detail}>
      <XCircle size={11} /> {result.error?.code}
    </span>
  );
}

function NewProviderForm({
  presets,
  onCreated,
  onCancel,
}: {
  presets: PresetProvider[];
  onCreated: (provider: Provider) => void;
  onCancel: () => void;
}) {
  const [presetId, setPresetId] = useState(presets[0]?.id ?? '');
  const selected = presets.find((p) => p.id === presetId);
  const [name, setName] = useState(selected?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(selected?.default_base_url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-fill when the preset changes.
  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setBaseUrl(selected.default_base_url);
    }
  }, [selected]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const res = await apiFetch('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify({
        name,
        preset_id: presetId || null,
        protocol: selected?.protocol ?? 'openai-compatible',
        base_url: baseUrl,
        billing_type: selected?.billing_type ?? 'payg',
        ...(apiKey ? { api_key: apiKey } : {}),
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(data.error?.message ?? '保存失败');
      setSaving(false);
      return;
    }
    const data = (await res.json()) as { provider: Provider };
    onCreated(data.provider);
  };

  return (
    <div className="panel new-form">
      <h3>新建厂商</h3>
      <label className="field">
        <span>预置厂商</span>
        <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {presets.map((p) => (
            <option value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Base URL</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label className="field">
        <span>{selected?.key_label ?? 'API Key'}</span>
        <input
          type="password"
          value={apiKey}
          placeholder="可稍后填写"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button className="btn btn--ghost" onClick={onCancel}>取消</button>
        <button className="btn btn--primary" disabled={saving} onClick={submit}>
          {saving ? <Loader2 size={14} className="spin" /> : '保存并测试'}
        </button>
      </div>
    </div>
  );
}

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presets, setPresets] = useState<PresetProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await apiJson<{ providers: Provider[] }>(
      '/api/admin/providers',
    );
    setProviders(data.providers);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    void apiJson<PresetsResponse>('/api/admin/presets').then((d) =>
      setPresets(d.presets),
    );
  }, [load]);

  const runTest = useCallback(async (id: string) => {
    setTesting(id);
    const res = await apiFetch(`/api/admin/providers/${id}/test`, {
      method: 'POST',
    });
    const result = (await res.json()) as TestResult;
    setResults((prev) => ({ ...prev, [id]: result }));
    setTesting(null);
  }, []);

  const handleCreated = useCallback(
    (provider: Provider) => {
      setProviders((prev) => [...prev, provider]);
      setShowForm(false);
      if (provider.has_api_key) void runTest(provider.id);
    },
    [runTest],
  );

  if (loading) return <Loader2 className="spin" />;

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn btn--primary" onClick={() => setShowForm(true)}>
          <Plus size={14} /> 新建厂商
        </button>
      </div>

      {showForm && (
        <NewProviderForm
          presets={presets}
          onCreated={handleCreated}
          onCancel={() => setShowForm(false)}
        />
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>协议</th>
              <th>Base URL</th>
              <th>Key</th>
              <th>L1 状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr>
                <td>{p.name}</td>
                <td className="mono">{p.protocol}</td>
                <td className="mono dim">{p.base_url}</td>
                <td className="mono">{p.api_key_hint ?? '—'}</td>
                <td><TestBadge result={results[p.id]} /></td>
                <td>
                  <button
                    className="btn"
                    disabled={testing === p.id}
                    onClick={() => void runTest(p.id)}
                  >
                    {testing === p.id ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      '测试连接'
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
