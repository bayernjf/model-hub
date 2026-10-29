import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { apiFetch, apiJson } from './api';
import type {
  ModelView,
  Provider,
} from './types';

interface ProjectSummary {
  id: string;
  slug: string;
  display_name: string;
}

interface AssignmentSummary {
  id: string;
  model_id: string;
  role: string;
  alias: string | null;
  daily_budget_micros: number | null;
}

interface Draft {
  checked: boolean;
  role: string;
  alias: string;
  budget: string;
}

interface HealthSummary {
  assignment_id: string | null;
  level: string;
  ok: boolean;
  latency_ms: number;
  error_code: string | null;
  ts: string;
}

const MODALITY_SECTIONS = [
  { key: 'text', label: '文本' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'embedding', label: '嵌入' },
] as const;

function emptyDraft(): Draft {
  return { checked: false, role: 'primary', alias: '', budget: '' };
}

export default function Assignments() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeProject, setActiveProject] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthSummary[]>([]);
  const [revision, setRevision] = useState<number>(1);
  const [assignmentIdByModel, setAssignmentIdByModel] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    void apiJson<{ projects: ProjectSummary[] }>(
      '/api/admin/projects',
    ).then((d) => {
      setProjects(d.projects);
      setActiveProject(d.projects[0]?.id ?? '');
    });
    void apiJson<{ models: ModelView[] }>('/api/admin/models').then((d) =>
      setModels(d.models),
    );
    void apiJson<{ providers: Provider[] }>('/api/admin/providers').then((d) =>
      setProviders(d.providers),
    );
  }, []);

  const loadAssignments = useCallback(
    async (projectId: string) => {
      if (!projectId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const data = await apiJson<{ assignments: AssignmentSummary[] }>(
        `/api/admin/assignments?project=${projectId}`,
      );
      const next: Record<string, Draft> = {};
      const idByModel: Record<string, string> = {};
      for (const a of data.assignments) {
        idByModel[a.model_id] = a.id;
      }
      setAssignmentIdByModel(idByModel);
      for (const m of models) {
        const assigned = data.assignments.find((a) => a.model_id === m.id);
        next[m.id] = assigned
          ? {
              checked: true,
              role: assigned.role,
              alias: assigned.alias ?? '',
              budget:
                assigned.daily_budget_micros !== null
                  ? String(assigned.daily_budget_micros)
                  : '',
            }
          : emptyDraft();
      }
      setDrafts(next);

      const healthData = await apiJson<{ health_checks: HealthSummary[] }>(
        `/api/admin/health-checks?project=${projectId}`,
      );
      setHealth(healthData.health_checks);
      const status = await apiJson<{ revision: number }>(
        '/api/admin/status',
      );
      setRevision(status.revision);

      setLoading(false);
    },
    [models],
  );

  useEffect(() => {
    if (models.length > 0 && activeProject) {
      void loadAssignments(activeProject);
    }
  }, [activeProject, models, loadAssignments]);

  const updateDraft = (modelId: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({
      ...prev,
      [modelId]: { ...(prev[modelId] ?? emptyDraft()), ...patch },
    }));
  };

  const toggleModel = (modelId: string, checked: boolean) => {
    updateDraft(modelId, { checked });
  };

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    const assignments = Object.entries(drafts)
      .filter(([, d]) => d.checked)
      .map(([model_id, d]) => ({
        model_id,
        role: d.role,
        alias: d.alias.trim() ? d.alias.trim() : null,
        daily_budget_micros: d.budget ? Number(d.budget) : null,
      }));
    const res = await apiFetch('/api/admin/assignments', {
      method: 'PUT',
      body: JSON.stringify({
        project_id: activeProject,
        assignments,
      }),
    });
    setSaving(false);
    if (res.ok) {
      setMessage('已保存');
      void loadAssignments(activeProject);
    } else {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setMessage(data.error?.message ?? '保存失败');
    }
  }, [drafts, activeProject, loadAssignments]);

  const providerName = useCallback(
    (providerId: string) =>
      providers.find((p) => p.id === providerId)?.name ?? providerId,
    [providers],
  );

  if (projects.length === 0) {
    return <p className="dim">请先在项目页创建项目。</p>;
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <select
          value={activeProject}
          onChange={(e) => setActiveProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.slug}</option>
          ))}
        </select>
        <button
          className="btn btn--primary"
          disabled={saving || loading}
          onClick={save}
        >
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          整批保存
        </button>
      </div>

      {message && <div className="dim">{message}</div>}

      <div className="dashboard-bar">
        <span>当前 revision：<b className="mono">{revision}</b></span>
        <span>已分配模型：<b className="mono">{Object.keys(assignmentIdByModel).length}</b></span>
        <span>最近 L4 回报：<b className="mono">{health[0]?.ts?.slice(0, 19) ?? '无'}</b></span>
      </div>

      {loading ? (
        <Loader2 className="spin" />
      ) : (
        MODALITY_SECTIONS.map((section) => {
          const sectionModels = models.filter(
            (m) => m.modalities.includes(section.key) && m.enabled,
          );
          if (sectionModels.length === 0) return null;
          return (
            <div className="panel" key={section.key}>
              <h3 className="section-title">{section.label}</h3>
              {sectionModels.map((m) => {
                const draft = drafts[m.id] ?? emptyDraft();
                const asnId = assignmentIdByModel[m.id];
                const l4 = health.find((h) => h.assignment_id === asnId);
                return (
                  <div className="assign-row" key={m.id}>
                    <label className="assign-head">
                      <input
                        type="checkbox"
                        checked={draft.checked}
                        onChange={(e) => toggleModel(m.id, e.target.checked)}
                      />
                      <span>{m.display_name ?? m.model}</span>
                      <span className="mono dim">{providerName(m.provider_id)}</span>
                      {l4 ? (
                        <span className={`tag tag--${l4.ok ? 'ok' : 'fail'}`}>
                          L4 {l4.ok ? `${l4.latency_ms}ms` : l4.error_code}
                        </span>
                      ) : (
                        <span className="tag">L4 未测</span>
                      )}
                    </label>
                    {draft.checked && (
                      <div className="assign-fields">
                        <label className="mini-field">
                          <span>Role</span>
                          <select
                            value={draft.role}
                            onChange={(e) =>
                              updateDraft(m.id, { role: e.target.value })
                            }
                          >
                            <option value="primary">primary</option>
                            <option value="fallback">fallback</option>
                          </select>
                        </label>
                        <label className="mini-field">
                          <span>Alias</span>
                          <input
                            value={draft.alias}
                            placeholder="如 noul"
                            onChange={(e) =>
                              updateDraft(m.id, { alias: e.target.value })
                            }
                          />
                        </label>
                        <label className="mini-field">
                          <span>日预算(微美元)</span>
                          <input
                            value={draft.budget}
                            inputMode="numeric"
                            onChange={(e) =>
                              updateDraft(m.id, { budget: e.target.value })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}
