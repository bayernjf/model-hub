import { useCallback, useEffect, useReducer, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Plus,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, apiJson, errorText } from './api';
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

// Persisted last test from GET /api/admin/models (migration 013).
interface PersistedTest {
  deep: boolean;
  ok: boolean;
  latency_ms: number;
  error_code: string | null;
  tested_at: string;
}

function testedAtLabel(testedAt: string): string {
  return testedAt.slice(0, 19).replace('T', ' ');
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

function L2Badge({
  result,
  persisted,
}: {
  result?: L2Result | undefined;
  persisted?: PersistedTest | undefined;
}) {
  // A session result wins (it is the freshest); otherwise show the persisted
  // last test so the badge survives a reload.
  if (result) {
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
  if (persisted) {
    const when = `上次测试 ${testedAtLabel(persisted.tested_at)}`;
    if (persisted.ok) {
      return (
        <span className="tag tag--ok" title={when}>
          <CheckCircle2 size={11} /> {persisted.latency_ms}ms
        </span>
      );
    }
    return (
      <span className="tag tag--fail" title={when}>
        <XCircle size={11} /> {persisted.error_code ?? 'error'}
      </span>
    );
  }
  return <span className="tag">未测试</span>;
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
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);
  const [l2, setL2] = useState<Record<string, L2Result>>({});
  const [lastTests, setLastTests] = useState<Record<string, PersistedTest>>({});
  const [testing, setTesting] = useState<string | null>(null);
  // model_id -> number of distinct projects assigning it. Disabling an
  // assigned model breaks those projects' calls immediately, so the count
  // must be visible before the toggle, not after.
  const [assignCounts, setAssignCounts] = useState<Record<string, number>>({});
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const [modelsData, providersData, presetsData, assignmentsData] =
        await Promise.all([
          apiJson<{
            models: ModelView[];
            last_tests?: Record<string, PersistedTest>;
          }>('/api/admin/models'),
          apiJson<{ providers: Provider[] }>('/api/admin/providers'),
          apiJson<PresetsResponse>('/api/admin/presets'),
          apiJson<{
            assignments: Array<{ project_id: string; model_id: string }>;
          }>('/api/admin/assignments'),
        ]);
      setModels(modelsData.models);
      setLastTests(modelsData.last_tests ?? {});
      setProviders(providersData.providers);
      setPresets(presetsData.presets);
      const projectsByModel: Record<string, Set<string>> = {};
      for (const a of assignmentsData.assignments) {
        const set = projectsByModel[a.model_id] ?? new Set<string>();
        set.add(a.project_id);
        projectsByModel[a.model_id] = set;
      }
      const counts: Record<string, number> = {};
      for (const [modelId, projects] of Object.entries(projectsByModel)) {
        counts[modelId] = projects.size;
      }
      setAssignCounts(counts);
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      if (!enabled) {
        const assigned = assignCounts[id] ?? 0;
        if (
          assigned > 0 &&
          !window.confirm(
            `该模型已被 ${assigned} 个项目分配，停用后这些项目的调用会立即失败。确定停用？`,
          )
        ) {
          bump();
          return;
        }
      }
      await apiFetch(`/api/admin/models/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      void refresh();
    },
    [assignCounts, refresh],
  );

  const providerName = useCallback(
    (providerId: string) =>
      providers.find((p) => p.id === providerId)?.name ?? providerId,
    [providers],
  );

  const q = query.trim().toLowerCase();
  const filtered = models.filter((m) => {
    if (filter !== 'all' && !m.modalities.includes(filter)) return false;
    if (q === '') return true;
    const hay =
      `${m.display_name ?? ''} ${m.model} ${providerName(m.provider_id)}`.toLowerCase();
    return hay.includes(q);
  });

  if (loadError) {
    return (
      <div className="panel stack">
        <p className="error">加载失败：{loadError}</p>
        <div>
          <button className="btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <Loader2 className="spin" />;

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          type="search"
          value={query}
          placeholder="搜索模型 / 厂商…"
          aria-label="搜索模型"
          onChange={(e) => setQuery(e.target.value)}
        />
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
            void refresh();
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
              <th>分配</th>
              <th>L2 状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const assigned = assignCounts[m.id] ?? 0;
              return (
                <tr key={m.id}>
                  <td>{m.display_name ?? m.model}</td>
                  <td>{providerName(m.provider_id)}</td>
                  <td className="mono dim">{m.modalities.join(',')}</td>
                  <td><PriceText model={m} /></td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`启用 ${m.display_name ?? m.model}`}
                      checked={m.enabled}
                      onChange={(e) =>
                        void toggleEnabled(m.id, e.target.checked)
                      }
                    />
                  </td>
                  <td>
                    {assigned > 0 ? (
                      <span className="tag tag--warn">已分配 {assigned} 项目</span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td>
                    <L2Badge result={l2[m.id]} persisted={lastTests[m.id]} />
                  </td>
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
              );
            })}
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
