import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Copy,
  KeyRound,
  Loader2,
  Plus,
} from 'lucide-react';
import { apiFetch, apiJson, errorText } from './api';

interface Project {
  id: string;
  slug: string;
  display_name: string;
  enabled: boolean;
}

interface ProjectDetail extends Project {
  tokens: TokenView[];
}

interface TokenView {
  id: string;
  token_hint: string | null;
  enabled: boolean;
  created_at: string;
  last_used_at: string | null;
}

export default function Projects() {
  const [projects, setProjects] = useState<ProjectDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [plainToken, setPlainToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // The list endpoint returns summary rows; fetch details for tokens.
      const list = await apiJson<{ projects: Project[] }>(
        '/api/admin/projects',
      );
      const details = await Promise.all(
        list.projects.map(async (p) => {
          const d = await apiJson<{ project: ProjectDetail }>(
            `/api/admin/projects/${p.id}`,
          );
          return d.project;
        }),
      );
      setProjects(details);
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rotateToken = useCallback(
    async (projectId: string) => {
      setBusy(projectId);
      const res = await apiFetch(
        `/api/admin/projects/${projectId}/rotate-token`,
        { method: 'POST' },
      );
      const data = (await res.json()) as { token: string };
      setPlainToken(data.token);
      setBusy(null);
      void load();
    },
    [load],
  );

  const setTokenEnabled = useCallback(
    async (tokenId: string, enabled: boolean) => {
      setBusy(tokenId);
      await apiFetch(`/api/admin/projects/tokens/${tokenId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      setBusy(null);
      void load();
    },
    [load],
  );

  if (loadError) {
    return (
      <div className="panel stack">
        <p className="error">加载失败：{loadError}</p>
        <div>
          <button className="btn" onClick={() => void load()}>
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
        <button className="btn btn--primary" onClick={() => setShowForm(true)}>
          <Plus size={14} /> 新建项目
        </button>
      </div>

      {showForm && (
        <NewProjectForm
          onCancel={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}

      {plainToken && (
        <div className="drawer-backdrop">
          <div className="panel token-modal">
            <h3>项目 Token（仅显示一次）</h3>
            <p className="dim">
              请立即复制并保存到项目的 <code>MODEL_HUB_TOKEN</code>。关闭后无法再次查看。
            </p>
            <pre className="token-plain">{plainToken}</pre>
            <div className="form-actions">
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(plainToken);
                }}
              >
                <Copy size={14} /> 复制
              </button>
              <button
                className="btn btn--primary"
                onClick={() => setPlainToken(null)}
              >
                我已保存
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>名称</th>
              <th>状态</th>
              <th>Tokens</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <Fragment key={p.id}>
                <tr
                  className="project-row"
                  onClick={() => toggleExpand(p.id)}
                >
                  <td className="mono">{p.slug}</td>
                  <td>{p.display_name}</td>
                  <td>
                    <span className={`tag tag--${p.enabled ? 'ok' : 'fail'}`}>
                      {p.enabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="mono dim">{p.tokens.length}</td>
                  <td>
                    <button
                      className="btn"
                      disabled={busy === p.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void rotateToken(p.id);
                      }}
                    >
                      {busy === p.id ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <KeyRound size={13} />
                      )}
                      签发 Token
                    </button>
                  </td>
                </tr>
                {expanded.has(p.id) && (
                  <tr>
                    <td colSpan={5}>
                      <div className="token-list">
                        {p.tokens.length === 0 && (
                          <span className="dim">暂无 Token</span>
                        )}
                        {p.tokens.map((t) => (
                          <div className="token-item" key={t.id}>
                            <span className="mono">{t.token_hint}</span>
                            <span className="dim">
                              {t.last_used_at ?? '从未使用'}
                            </span>
                            <button
                              className="btn btn--ghost"
                              disabled={busy === t.id}
                              onClick={() =>
                                void setTokenEnabled(t.id, !t.enabled)
                              }
                            >
                              {t.enabled ? '停用' : '启用'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const res = await apiFetch('/api/admin/projects', {
      method: 'POST',
      body: JSON.stringify({
        slug,
        display_name: displayName || slug,
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string };
      };
      setError(
        data.error?.message ??
          (data.error?.code === 'slug_conflict' ? 'Slug 已存在' : '保存失败'),
      );
      setSaving(false);
      return;
    }
    onCreated();
  };

  return (
    <div className="panel new-form">
      <h3>新建项目</h3>
      <label className="field">
        <span>Slug</span>
        <input
          value={slug}
          placeholder="如 zeus"
          onChange={(e) => setSlug(e.target.value)}
        />
      </label>
      <label className="field">
        <span>显示名称</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button className="btn btn--ghost" onClick={onCancel}>取消</button>
        <button className="btn btn--primary" disabled={saving} onClick={submit}>
          {saving ? <Loader2 size={14} className="spin" /> : '保存'}
        </button>
      </div>
    </div>
  );
}

