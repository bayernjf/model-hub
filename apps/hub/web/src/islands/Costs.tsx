import { useCallback, useEffect, useState } from 'react';
import AsyncState from './AsyncState';
import { apiJson, errorText } from './api';

interface CostCell {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  quantity: number;
  cost_micros: number;
}

interface SourceSplit {
  builtin: CostCell;
  byok: CostCell;
}

interface CostsResponse {
  totals: SourceSplit;
  by_project: Array<{ project: string } & SourceSplit>;
  by_day: Array<{ day: string } & SourceSplit>;
  by_model: Array<{ project: string; model: string } & SourceSplit>;
  budgets: BudgetRow[];
}

// Budget watermark (W5-3): today's UTC builtin spend per budgeted
// assignment vs its daily budget. Rows without a configured budget are
// omitted server-side.
interface BudgetRow {
  project: string;
  assignment_id: string;
  alias: string | null;
  role: string;
  model: string;
  spent_micros: number;
  daily_budget_micros: number;
  percent: number | null;
}

const DAY_MS = 86_400_000;

// Time-range presets (W2-6). "全部" keeps the original unfiltered view;
// the others send an inclusive from/to window as query params.
const RANGES = [
  { key: 'all', label: '全部', days: null },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

function windowQuery(range: RangeKey): string {
  const preset = RANGES.find((r) => r.key === range);
  if (!preset?.days) return '';
  const from = new Date(Date.now() - (preset.days - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: new Date().toISOString(),
  });
  return `?${params.toString()}`;
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function watermarkColor(percent: number | null): string {
  if (percent === null) return 'var(--warn, #b45309)';
  if (percent >= 100) return 'var(--bad, #b91c1c)';
  if (percent >= 80) return 'var(--warn, #b45309)';
  return 'inherit';
}

function BudgetWatermark({ row }: { row: BudgetRow }) {
  if (row.percent === null) {
    return <span style={{ color: watermarkColor(null) }}>超限（零预算）</span>;
  }
  return (
    <span style={{ color: watermarkColor(row.percent) }}>
      {row.percent.toFixed(2)}%（{usd(row.spent_micros)} /{' '}
      {usd(row.daily_budget_micros)}）
    </span>
  );
}

function Row({ split }: { split: SourceSplit }) {
  return (
    <>
      <td>{split.builtin.calls}</td>
      <td>{split.builtin.input_tokens}</td>
      <td>{split.builtin.output_tokens}</td>
      <td>{split.builtin.reasoning_tokens}</td>
      <td>{split.builtin.cache_read_tokens}</td>
      <td>{usd(split.builtin.cost_micros)}</td>
      <td>{split.byok.calls}</td>
      <td>{split.byok.input_tokens + split.byok.output_tokens}</td>
    </>
  );
}

export default function Costs() {
  const [data, setData] = useState<CostsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('all');
  const [attempt, setAttempt] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Custom date range (branch m7-wrapup): overrides the preset when set.
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const qs = customRange
      ? `?from=${encodeURIComponent(customRange.from)}&to=${encodeURIComponent(customRange.to)}`
      : windowQuery(range);
    apiJson<CostsResponse>(`/api/admin/costs${qs}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((thrown) => {
        if (!cancelled) {
          setLoadError(thrown instanceof Error ? thrown.message : String(thrown));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, attempt, customRange]);

  const applyCustom = () => {
    if (!from && !to) {
      setCustomRange(null);
      setRange('all');
      return;
    }
    setCustomRange({ from, to });
    setAttempt((a) => a + 1);
  };

  const clearCustom = () => {
    setFrom('');
    setTo('');
    setCustomRange(null);
    setRange('all');
    setAttempt((a) => a + 1);
  };

  if (loading && !data) return <AsyncState loading />;
  if (loadError) return <AsyncState error={loadError} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!data) return <AsyncState empty emptyText="暂无用量数据。" />;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar">
        <div className="filters">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`btn ${range === r.key && !customRange ? 'btn--primary' : ''}`}
              onClick={() => {
                setRange(r.key);
                setCustomRange(null);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="filters">
          <input
            type="date"
            aria-label="开始日期"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input
            type="date"
            aria-label="结束日期"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <button className="btn btn--primary" onClick={applyCustom}>
            查询
          </button>
          <button className="btn btn--ghost" onClick={clearCustom}>
            清除
          </button>
        </div>
        {loading && <p className="dim">刷新中…</p>}
      </div>

      <section>
        <h2>总计</h2>
        <table>
          <thead>
            <tr>
              <th>来源</th>
              <th>调用次数</th>
              <th>输入 tokens</th>
              <th>输出 tokens</th>
              <th>推理 tokens</th>
              <th>缓存读取 tokens</th>
              <th>成本 (USD)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>builtin（hub 分配）</td>
              <td>{data.totals.builtin.calls}</td>
              <td>{data.totals.builtin.input_tokens}</td>
              <td>{data.totals.builtin.output_tokens}</td>
              <td>{data.totals.builtin.reasoning_tokens}</td>
              <td>{data.totals.builtin.cache_read_tokens}</td>
              <td>{usd(data.totals.builtin.cost_micros)}</td>
            </tr>
            <tr>
              <td>byok（用户自带 key）</td>
              <td>{data.totals.byok.calls}</td>
              <td>{data.totals.byok.input_tokens}</td>
              <td>{data.totals.byok.output_tokens}</td>
              <td>{data.totals.byok.reasoning_tokens}</td>
              <td>{data.totals.byok.cache_read_tokens}</td>
              <td>—（用户自付）</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>按天</h2>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>builtin 调用</th>
              <th>builtin 输入</th>
              <th>builtin 输出</th>
              <th>builtin 推理</th>
              <th>builtin 缓存读</th>
              <th>builtin 成本</th>
              <th>byok 调用</th>
              <th>byok tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.by_day.length === 0 && (
              <tr>
                <td colSpan={9}>暂无用量上报</td>
              </tr>
            )}
            {data.by_day.map((row) => (
              <tr key={row.day}>
                <td>{row.day}</td>
                <Row split={row} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>按项目</h2>
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>builtin 调用</th>
              <th>builtin 输入</th>
              <th>builtin 输出</th>
              <th>builtin 推理</th>
              <th>builtin 缓存读</th>
              <th>builtin 成本</th>
              <th>byok 调用</th>
              <th>byok tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.by_project.length === 0 && (
              <tr>
                <td colSpan={9}>暂无用量上报</td>
              </tr>
            )}
            {data.by_project.map((row) => (
              <tr key={row.project}>
                <td>{row.project}</td>
                <Row split={row} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>预算水位（UTC 当日）</h2>
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>别名</th>
              <th>角色</th>
              <th>模型</th>
              <th>已用（今日）</th>
              <th>日预算</th>
              <th>水位</th>
            </tr>
          </thead>
          <tbody>
            {data.budgets.length === 0 && (
              <tr>
                <td colSpan={7}>暂无配置日预算的分配</td>
              </tr>
            )}
            {data.budgets.map((row) => (
              <tr key={row.assignment_id}>
                <td>{row.project}</td>
                <td>{row.alias ?? '—'}</td>
                <td>{row.role}</td>
                <td>{row.model}</td>
                <td>{usd(row.spent_micros)}</td>
                <td>{usd(row.daily_budget_micros)}</td>
                <td>
                  <BudgetWatermark row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>按模型</h2>
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>模型</th>
              <th>builtin 调用</th>
              <th>builtin 输入</th>
              <th>builtin 输出</th>
              <th>builtin 推理</th>
              <th>builtin 缓存读</th>
              <th>builtin 成本</th>
              <th>byok 调用</th>
              <th>byok tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.by_model.length === 0 && (
              <tr>
                <td colSpan={10}>暂无用量上报</td>
              </tr>
            )}
            {data.by_model.map((row) => (
              <tr key={`${row.project}/${row.model}`}>
                <td>{row.project}</td>
                <td>{row.model}</td>
                <Row split={row} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
