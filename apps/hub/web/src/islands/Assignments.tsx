import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { apiFetch, apiJson, errorText } from './api';
import type {
  ModelView,
  Provider,
} from './types';

interface ProjectSummary {
  id: string;
  slug: string;
  display_name: string;
}

interface AssignmentRow {
  id: string;
  model_id: string;
  role: string;
  alias: string | null;
  daily_budget_micros: number | null;
}

// One alias under one model. Migration 012 lets a model serve a project
// under several distinct aliases, so a model's draft is a list of entries.
interface Entry {
  role: string;
  alias: string;
  budget: string;
}

type DraftMap = Record<string, Entry[]>;

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

function emptyEntry(): Entry {
  return { role: 'primary', alias: '', budget: '' };
}

// Micro-dollar budget as typed; '' means unset, NaN marks malformed input so
// it still counts as a pending change instead of silently matching.
function budgetVal(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

function entryKey(modelId: string, e: Entry): string {
  const budget = budgetVal(e.budget);
  return `${modelId}|${e.role}|${e.alias.trim()}|${budget ?? ''}`;
}

function keyLabel(name: string, key: string): string {
  const alias = key.split('|')[2] ?? '';
  return alias === '' ? `${name}（未填 alias）` : `${name}（${alias}）`;
}

interface DraftDiff {
  added: string[];
  removed: string[];
}

// Drafts vs the server state of the active project; entries carry
// "model (alias)" labels for direct use in the dirty badge and confirm
// dialogs. Editing an entry shows up as remove + add: the PUT below replaces
// the project's whole assignment set, and unchecking an assigned model would
// revoke the alias on the product side, so saving is always guarded.
function computeDiff(
  drafts: DraftMap,
  saved: DraftMap,
  models: ModelView[],
): DraftDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const m of models) {
    const dKeys = new Set((drafts[m.id] ?? []).map((e) => entryKey(m.id, e)));
    const sKeys = new Set((saved[m.id] ?? []).map((e) => entryKey(m.id, e)));
    const name = m.display_name ?? m.model;
    for (const k of dKeys) if (!sKeys.has(k)) added.push(keyLabel(name, k));
    for (const k of sKeys) if (!dKeys.has(k)) removed.push(keyLabel(name, k));
  }
  return { added, removed };
}

type SaveMessage = { kind: 'ok' | 'error' | 'info'; text: string };

export default function Assignments() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeProject, setActiveProject] = useState<string>('');
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [saved, setSaved] = useState<DraftMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SaveMessage | null>(null);
  const [metaReady, setMetaReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // Remount handle for the project select: bumping it reverts the DOM select
  // to the active project after a cancelled switch.
  const [selectKey, setSelectKey] = useState(0);
  const [revision, setRevision] = useState<number>(1);
  const [health, setHealth] = useState<HealthSummary[]>([]);
  // assignment id (and L4 health) lookup by normalized entry key.
  const [savedIdByKey, setSavedIdByKey] = useState<Record<string, string>>({});
  const [healthByAssignment, setHealthByAssignment] = useState<
    Record<string, HealthSummary>
  >({});

  // Projects/models/providers bootstrap; assignments load per project below.
  const refresh = useCallback(async () => {
    setLoadError(null);
    setMetaReady(false);
    setLoading(true);
    try {
      const [projectData, modelData, providerData] = await Promise.all([
        apiJson<{ projects: ProjectSummary[] }>('/api/admin/projects'),
        apiJson<{ models: ModelView[] }>('/api/admin/models'),
        apiJson<{ providers: Provider[] }>('/api/admin/providers'),
      ]);
      setProjects(projectData.projects);
      setModels(modelData.models);
      setProviders(providerData.providers);
      setActiveProject(projectData.projects[0]?.id ?? '');
      setMetaReady(true);
    } catch (err) {
      setLoadError(errorText(err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadAssignments = useCallback(
    async (projectId: string) => {
      setLoading(true);
      try {
        const [asnData, healthData, statusData] = await Promise.all([
          apiJson<{ assignments: AssignmentRow[] }>(
            `/api/admin/assignments?project=${projectId}`,
          ),
          apiJson<{ health_checks: HealthSummary[] }>(
            `/api/admin/health-checks?project=${projectId}`,
          ),
          apiJson<{ revision: number }>('/api/admin/status'),
        ]);

        const nextSaved: DraftMap = {};
        for (const m of models) nextSaved[m.id] = [];
        const idByKey: Record<string, string> = {};
        for (const a of asnData.assignments) {
          const entry: Entry = {
            role: a.role,
            alias: a.alias ?? '',
            budget:
              a.daily_budget_micros !== null ? String(a.daily_budget_micros) : '',
          };
          nextSaved[a.model_id] = [...(nextSaved[a.model_id] ?? []), entry];
          idByKey[entryKey(a.model_id, entry)] = a.id;
        }
        setSaved(nextSaved);
        setDrafts(nextSaved);
        setSavedIdByKey(idByKey);

        const byAssignment: Record<string, HealthSummary> = {};
        for (const h of healthData.health_checks) {
          if (h.assignment_id) byAssignment[h.assignment_id] = h;
        }
        setHealthByAssignment(byAssignment);
        setHealth(healthData.health_checks);
        setRevision(statusData.revision);
      } catch (err) {
        setLoadError(errorText(err));
      } finally {
        setLoading(false);
      }
    },
    [models],
  );

  useEffect(() => {
    if (!metaReady) return;
    if (!activeProject) {
      setLoading(false);
      return;
    }
    void loadAssignments(activeProject);
  }, [activeProject, metaReady, reloadTick, loadAssignments]);

  const updateEntry = (modelId: string, index: number, patch: Partial<Entry>) => {
    setDrafts((prev) => {
      const list = prev[modelId] ?? [];
      return {
        ...prev,
        [modelId]: list.map((e, i) => (i === index ? { ...e, ...patch } : e)),
      };
    });
  };

  const toggleModel = (modelId: string, checked: boolean) => {
    setDrafts((prev) => ({
      ...prev,
      [modelId]: checked
        ? (prev[modelId]?.length ?? 0) > 0
          ? (prev[modelId] ?? [])
          : [emptyEntry()]
        : [],
    }));
  };

  const diff = useMemo(
    () => computeDiff(drafts, saved, models),
    [drafts, saved, models],
  );
  const dirtyCount = diff.added.length + diff.removed.length;

  const onProjectChange = (next: string) => {
    if (next === activeProject) return;
    if (!loading && dirtyCount > 0) {
      const ok = window.confirm(
        `当前项目有未保存的修改（新增 ${diff.added.length} · 移除 ${diff.removed.length}），切换将丢弃。继续？`,
      );
      if (!ok) {
        setSelectKey((k) => k + 1);
        return;
      }
    }
    setMessage(null);
    setActiveProject(next);
  };

  const save = useCallback(async () => {
    const d = computeDiff(drafts, saved, models);
    if (d.added.length + d.removed.length === 0) {
      setMessage({ kind: 'info', text: '无改动' });
      return;
    }
    if (
      d.removed.length > 0 &&
      !window.confirm(
        `将移除 ${d.removed.length} 条分配，产品侧会立即失去这些 alias：\n${d.removed.join('、')}\n\n确定保存？`,
      )
    ) {
      return;
    }
    setSaving(true);
    setMessage(null);
    const assignments = models.flatMap((m) =>
      (drafts[m.id] ?? []).map((e) => {
        const budget = budgetVal(e.budget);
        return {
          model_id: m.id,
          role: e.role,
          alias: e.alias.trim() ? e.alias.trim() : null,
          daily_budget_micros:
            budget === null || Number.isNaN(budget) ? null : budget,
        };
      }),
    );
    let res: Response;
    try {
      res = await apiFetch('/api/admin/assignments', {
        method: 'PUT',
        body: JSON.stringify({ project_id: activeProject, assignments }),
      });
    } catch {
      // 401: apiFetch already redirected to the login page.
      return;
    }
    setSaving(false);
    if (res.ok) {
      setMessage({
        kind: 'ok',
        text: `已保存（新增 ${d.added.length} · 移除 ${d.removed.length}）`,
      });
      void loadAssignments(activeProject);
    } else {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setMessage({ kind: 'error', text: data.error?.message ?? '保存失败' });
    }
  }, [drafts, saved, models, activeProject, loadAssignments]);

  const providerName = useCallback(
    (providerId: string) =>
      providers.find((p) => p.id === providerId)?.name ?? providerId,
    [providers],
  );

  const retry = () => {
    setLoadError(null);
    if (metaReady) setReloadTick((t) => t + 1);
    else void refresh();
  };

  if (loadError) {
    return (
      <div className="panel stack">
        <p className="error">加载失败：{loadError}</p>
        <div>
          <button className="btn" onClick={retry}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (projects.length === 0 && metaReady) {
    return <p className="dim">请先在项目页创建项目。</p>;
  }

  const assignedModelCount = Object.values(saved).filter(
    (entries) => entries.length > 0,
  ).length;

  return (
    <div className="stack">
      <div className="toolbar">
        <select
          key={selectKey}
          value={activeProject}
          onChange={(e) => onProjectChange(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.slug}</option>
          ))}
        </select>
        {!loading && dirtyCount > 0 && (
          <span className="tag tag--warn">
            未保存：新增 {diff.added.length} · 移除 {diff.removed.length}
          </span>
        )}
        <button
          className="btn btn--primary"
          disabled={saving || loading}
          onClick={save}
        >
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          整批保存
        </button>
      </div>

      {message && (
        <div
          role="status"
          aria-live="polite"
          className={
            message.kind === 'ok'
              ? 'ok-text'
              : message.kind === 'error'
                ? 'error'
                : 'dim'
          }
        >
          {message.text}
        </div>
      )}

      <div className="dashboard-bar">
        <span>当前 revision：<b className="mono">{revision}</b></span>
        <span>已分配模型：<b className="mono">{assignedModelCount}</b></span>
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
                const entries = drafts[m.id] ?? [];
                const name = m.display_name ?? m.model;
                return (
                  <div className="assign-row" key={m.id}>
                    <label className="assign-head">
                      <input
                        type="checkbox"
                        aria-label={`分配 ${name}`}
                        checked={entries.length > 0}
                        onChange={(e) => toggleModel(m.id, e.target.checked)}
                      />
                      <span>{name}</span>
                      <span className="mono dim">{providerName(m.provider_id)}</span>
                    </label>
                    {entries.map((e, i) => {
                      const asnId = savedIdByKey[entryKey(m.id, e)];
                      const l4 = asnId ? healthByAssignment[asnId] : undefined;
                      const budget = budgetVal(e.budget);
                      return (
                        <div className="assign-fields" key={i}>
                          <label className="mini-field">
                            <span>Role</span>
                            <select
                              value={e.role}
                              onChange={(ev) =>
                                updateEntry(m.id, i, { role: ev.target.value })
                              }
                            >
                              <option value="primary">primary</option>
                              <option value="fallback">fallback</option>
                            </select>
                          </label>
                          <label className="mini-field">
                            <span>Alias</span>
                            <input
                              value={e.alias}
                              placeholder="如 noul"
                              onChange={(ev) =>
                                updateEntry(m.id, i, { alias: ev.target.value })
                              }
                            />
                          </label>
                          <div className="mini-field">
                            <span>日预算(微美元)</span>
                            <input
                              value={e.budget}
                              inputMode="numeric"
                              onChange={(ev) =>
                                updateEntry(m.id, i, { budget: ev.target.value })
                              }
                            />
                            {budget !== null && !Number.isNaN(budget) && (
                              <span className="mini-hint">
                                ≈ ${(budget / 1_000_000).toFixed(2)} / 天
                              </span>
                            )}
                          </div>
                          {l4 && (
                            <span
                              className={`tag tag--${l4.ok ? 'ok' : 'fail'}`}
                              style={{ alignSelf: 'flex-end' }}
                            >
                              L4 {l4.ok ? `${l4.latency_ms}ms` : l4.error_code}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn btn--ghost"
                            aria-label={`移除 ${name} 的这条 alias`}
                            onClick={() =>
                              setDrafts((prev) => ({
                                ...prev,
                                [m.id]: (prev[m.id] ?? []).filter(
                                  (_, idx) => idx !== i,
                                ),
                              }))
                            }
                          >
                            移除
                          </button>
                        </div>
                      );
                    })}
                    {entries.length > 0 && (
                      <button
                        type="button"
                        className="btn btn--ghost add-alias"
                        onClick={() =>
                          setDrafts((prev) => ({
                            ...prev,
                            [m.id]: [...(prev[m.id] ?? []), emptyEntry()],
                          }))
                        }
                      >
                        + 添加 alias
                      </button>
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
