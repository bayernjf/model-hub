import { useEffect, useState } from 'react';
import { apiJson } from './api';

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
  const [range, setRange] = useState<RangeKey>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiJson<CostsResponse>(`/api/admin/costs${windowQuery(range)}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  if (loading && !data) return <p>加载中…</p>;
  if (!data) return <p>无数据。</p>;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar">
        <div className="filters">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`btn ${range === r.key ? 'btn--primary' : ''}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
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
