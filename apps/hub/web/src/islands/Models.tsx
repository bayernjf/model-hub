import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Plus,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, apiJson } from './api';
import type {
  ModelView,
  Provider,
  PresetProvider,
  PresetsResponse,
} from './types';

interface L2Result {
  ok: boolean;
  latency_ms: number;
  error?: { code: string; hint?: string; detail?: string };
}

function PriceText({ model }: { model: ModelView }) {
  const p = model.pricing;
  if (model.modalities.includes('text') || model.modalities.includes('embedding')) {
    return (
      <span className="mono dim">
        {p.input_usd_per_million ?? '—'} / {p.output_usd_per_million ?? '—'}
      </span>
    );
  }
  if (model.modalities.includes('image')) {
    return <span className="mono dim">{p.per_image ?? '—'} /张</span>;
  }
  if (model.modalities.includes('video')) {
    return <span className="mono dim">{p.per_second ?? '—'} /秒</span>;
  }
  if (model.modalities.includes('audio')) {
    return <span className="mono dim">{p.per_kilo_char ?? '—'} /千字符</span>;
  }
  return <span>—</span>;
}

function L2Badge({ result }: { result: L2Result | undefined }) {
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

const MODALITY_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'embedding', label: '嵌入' },
] as const;

export default function Models() {
  const [models, setModels] = useState<ModelView[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presets, setPresets] = useState<PresetProvider[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [showDrawer, setShowDrawer] = useState(false);
  const [l2, setL2] = useState<Record<string, L2Result>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await apiJson<{ models: ModelView[] }>('/api/admin/models');
    setModels(data.models);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    void apiJson<{ providers: Provider[] }>('/api/admin/providers').then((d) =>
      setProviders(d.providers),
    );
    void apiJson<PresetsResponse>('/api/admin/presets').then((d) =>
      setPresets(d.presets),
    );
  }, [load]);

  const runL2 = useCallback(
    async (id: string, deep: boolean) => {
      setTesting(id);
      const query = deep ? '?deep=true' : '';
      const res = await apiFetch(`/api/admin/models/${id}/test${query}`, {
        method: 'POST',
      });
      const result = (await res.json()) as L2Result;
      setL2((prev) => ({ ...prev, [id]: result }));
      setTesting(null);
    },
    [],
  );

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      await apiFetch(`/api/admin/models/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      void load();
    },
    [load],
  );

  const providerName = useCallback(
    (providerId: string) =>
      providers.find((p) => p.id === providerId)?.name ?? providerId,
    [providers],
  );

  const filtered = models.filter(
    (m) => filter === 'all' || m.modalities.includes(filter),
  );

  if (loading) return <Loader2 className="spin" />;

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="filters">
          {MODALITY_FILTERS.map((f) => (
            <button
              key={f.value}
              className={`btn ${filter === f.value ? 'btn--primary' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn btn--primary" onClick={() => setShowDrawer(true)}>
          <Plus size={14} /> 从清单添加
        </button>
      </div>

      {showDrawer && (
        <ImportDrawer
          presets={presets}
          providers={providers}
          onClose={() => setShowDrawer(false)}
          onImported={() => {
            setShowDrawer(false);
            void load();
          }}
        />
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>厂商</th>
              <th>模态</th>
              <th>单价</th>
              <th>启用</th>
              <th>L2 状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id}>
                <td>{m.display_name ?? m.model}</td>
                <td>{providerName(m.provider_id)}</td>
                <td className="mono dim">{m.modalities.join(',')}</td>
                <td><PriceText model={m} /></td>
                <td>
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={(e) => void toggleEnabled(m.id, e.target.checked)}
                  />
                </td>
                <td><L2Badge result={l2[m.id]} /></td>
                <td>
                  <button
                    className="btn"
                    disabled={testing === m.id}
                    onClick={() => void runL2(m.id, false)}
                  >
                    {testing === m.id ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      '测试'
                    )}
                  </button>
                  {(m.modalities.includes('image') ||
                    m.modalities.includes('video')) && (
                    <button
                      className="btn btn--ghost"
                      onClick={() => {
                        if (
                          confirm('深度测试会产生极少费用，且视频只提交一次。继续？')
                        )
                          void runL2(m.id, true);
                      }}
                    >
                      深度测试
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Import drawer: preset groups on the left, model checkboxes on the right.
// Nothing is selected by default. Import targets the provider created from
// the same preset.
function ImportDrawer({
  presets,
  providers,
  onClose,
  onImported,
}: {
  presets: PresetProvider[];
  providers: Provider[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [activePreset, setActivePreset] = useState(presets[0]?.id ?? '');
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = presets.find((p) => p.id === activePreset);
  // The provider created from this preset, if any.
  const targetProvider = providers.find((p) => p.preset_id === activePreset);

  const toggle = (modelId: string) => {
    setSelected((prev) => {
      const set = new Set(prev[activePreset] ?? []);
      if (set.has(modelId)) set.delete(modelId);
      else set.add(modelId);
      return { ...prev, [activePreset]: set };
    });
  };

  const doImport = async () => {
    if (!targetProvider) {
      setError('该预置还没有对应的厂商，请先在厂商页创建。');
      return;
    }
    const ids = [...(selected[activePreset] ?? [])];
    if (ids.length === 0) {
      setError('请先勾选要导入的模型。');
      return;
    }
    setImporting(true);
    setError(null);
    const res = await apiFetch(
      `/api/admin/providers/${targetProvider.id}/models/import`,
      {
        method: 'POST',
        body: JSON.stringify({
          preset_provider_id: activePreset,
          model_ids: ids,
        }),
      },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(data.error?.message ?? '导入失败');
      setImporting(false);
      return;
    }
    onImported();
  };

  return (
    <div className="drawer-backdrop">
      <div className="drawer">
        <div className="drawer-head">
          <h3>从清单添加</h3>
          <button className="btn btn--ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="drawer-groups">
            {presets.map((p) => (
              <button
                key={p.id}
                className={`group-item ${p.id === activePreset ? 'active' : ''}`}
                onClick={() => setActivePreset(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="drawer-models">
            {preset?.models.map((m) => (
              <label key={m.id} className="model-check">
                <input
                  type="checkbox"
                  checked={selected[activePreset]?.has(m.id) ?? false}
                  onChange={() => toggle(m.id)}
                />
                <span>{m.display_name}</span>
                <span className="mono dim">{m.model}</span>
              </label>
            ))}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="drawer-foot">
          <button className="btn btn--ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn--primary"
            disabled={importing}
            onClick={doImport}
          >
            {importing ? <Loader2 size={14} className="spin" /> : '导入所选'}
          </button>
        </div>
      </div>
    </div>
  );
}
