import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { apiFetch, apiJson } from './api';

interface Project {
  id: string;
  slug: string;
  display_name: string;
}

interface KnowledgeDoc {
  id: string;
  title: string;
  source: string | null;
  mime: string | null;
  chunk_count: number;
  created_at: string;
}

interface Citation {
  chunk_id: string;
  doc_id: string;
  title: string;
  position: number;
  score: number;
  content: string;
}

interface QueryOutcome {
  answer: string | null;
  reranked: boolean;
  citations: Citation[];
}

interface ApiError {
  error?: { code?: string; message?: string };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Pull the code/message out of an API error response body.
async function apiErrorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiError;
    return body.error?.message ?? body.error?.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function Knowledge() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [ownerId, setOwnerId] = useState<string>('');
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);

  // Upload form state.
  const [title, setTitle] = useState('');
  const [mime, setMime] = useState('text/plain');
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);

  // Q&A state.
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null);

  const [error, setError] = useState<string | null>(null);

  const loadDocs = useCallback(async (owner: string) => {
    if (!owner) return;
    const res = await apiJson<{ documents: KnowledgeDoc[] }>(
      `/api/admin/knowledge/documents?owner=${encodeURIComponent(owner)}`,
    );
    setDocs(res.documents);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiJson<{ projects: Project[] }>(
          '/api/admin/projects',
        );
        if (cancelled) return;
        setProjects(list.projects);
        const first = list.projects[0]?.id ?? '';
        setOwnerId(first);
        await loadDocs(first);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDocs]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.pdf')) {
      setError('PDF 暂不支持：请粘贴文本，或改用 .md / .txt 文件。');
      return;
    }
    setError(null);
    setTitle(file.name);
    setMime(lower.endsWith('.md') || lower.endsWith('.markdown')
      ? 'text/markdown'
      : 'text/plain');
    setText(await file.text());
  };

  const upload = async () => {
    if (!ownerId || !title.trim() || !text.trim()) return;
    setUploading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/knowledge/ingest', {
        method: 'POST',
        body: JSON.stringify({ owner: ownerId, title, text, mime }),
      });
      if (!res.ok) throw new Error(await apiErrorText(res));
      setTitle('');
      setText('');
      await loadDocs(ownerId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('删除该文档及其全部 chunks？')) return;
    setError(null);
    try {
      const res = await apiFetch(
        `/api/admin/knowledge/documents/${id}?owner=${encodeURIComponent(ownerId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(await apiErrorText(res));
      await loadDocs(ownerId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const ask = async () => {
    if (!ownerId || !question.trim()) return;
    setAsking(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await apiFetch('/api/admin/knowledge/query', {
        method: 'POST',
        body: JSON.stringify({ owner: ownerId, query: question }),
      });
      if (!res.ok) throw new Error(await apiErrorText(res));
      setOutcome((await res.json()) as QueryOutcome);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAsking(false);
    }
  };

  if (loading) return <p>加载中…</p>;
  if (projects.length === 0) {
    return <p className="dim">尚无项目：请先在「项目」页创建一个项目作为文档 owner。</p>;
  }

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}

      <div className="toolbar">
        <label className="field">
          <span>文档 owner（项目）</span>
          <select
            value={ownerId}
            onChange={(e) => {
              setOwnerId(e.target.value);
              void loadDocs(e.target.value);
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}（{p.slug}）
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="panel">
        <h2>上传文档</h2>
        <div className="new-form">
          <div className="field">
            <span>标题</span>
            <input
              value={title}
              placeholder="例如：退款政策.md"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="field">
            <span>文件（.txt / .md；PDF 暂不支持）</span>
            <input
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </div>
          <div className="field">
            <span>或直接粘贴文本</span>
            <textarea
              rows={6}
              value={text}
              placeholder="文档正文…"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              className="btn btn--primary"
              disabled={uploading || !title.trim() || !text.trim()}
              onClick={() => void upload()}
            >
              {uploading ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}
              切分并向量化
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>文档列表</h2>
        <table>
          <thead>
            <tr>
              <th>标题</th>
              <th>来源</th>
              <th>类型</th>
              <th>chunks</th>
              <th>创建时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr>
                <td colSpan={6}>该 owner 暂无文档</td>
              </tr>
            )}
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.title}</td>
                <td>{doc.source ?? '—'}</td>
                <td>{doc.mime ?? '—'}</td>
                <td>{doc.chunk_count}</td>
                <td>{doc.created_at}</td>
                <td>
                  <button
                    className="btn btn--ghost"
                    title="删除文档"
                    onClick={() => void remove(doc.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>知识问答</h2>
        <div className="toolbar">
          <input
            style={{ flex: 1 }}
            value={question}
            placeholder="例如：我们的退款政策是什么？"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ask();
            }}
          />
          <button
            className="btn btn--primary"
            disabled={asking || !question.trim()}
            onClick={() => void ask()}
          >
            {asking && <Loader2 className="spin" size={14} />}
            提问
          </button>
        </div>
        {outcome && (
          <div style={{ marginTop: 14 }}>
            <div className="token-plain" style={{ marginBottom: 12 }}>
              {outcome.answer ?? '（未配置回答模型或无相关内容，仅返回出处）'}
            </div>
            <table className="citations">
              <thead>
                <tr>
                  <th>出处</th>
                  <th>位置</th>
                  <th>向量分</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {outcome.citations.map((c) => (
                  <tr key={c.chunk_id}>
                    <td>{c.title}</td>
                    <td>#{c.position}</td>
                    <td>{c.score.toFixed(4)}</td>
                    <td>{c.content.slice(0, 160)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="dim" style={{ fontSize: 12 }}>
              {outcome.reranked ? '已按 LLM 重排序' : '纯向量排序（重排未启用或失败回退）'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
