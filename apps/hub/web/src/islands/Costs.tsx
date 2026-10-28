import { useEffect, useState } from 'react';
import { apiJson } from './api';

interface CostCell {
  calls: number;
  input_tokens: number;
  output_tokens: number;
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

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function Row({ split }: { split: SourceSplit }) {
  return (
    <>
      <td>{split.builtin.calls}</td>
      <td>{split.builtin.input_tokens}</td>
      <td>{split.builtin.output_tokens}</td>
      <td>{usd(split.builtin.cost_micros)}</td>
      <td>{split.byok.calls}</td>
      <td>{split.byok.input_tokens + split.byok.output_tokens}</td>
    </>
  );
}

export default function Costs() {
  const [data, setData] = useState<CostsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiJson<CostsResponse>('/api/admin/costs')
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>加载中…</p>;
  if (!data) return <p>无数据。</p>;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section>
        <h2>总计</h2>
        <table>
          <thead>
            <tr>
              <th>来源</th>
              <th>调用次数</th>
              <th>输入 tokens</th>
              <th>输出 tokens</th>
              <th>成本 (USD)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>builtin（hub 分配）</td>
              <td>{data.totals.builtin.calls}</td>
              <td>{data.totals.builtin.input_tokens}</td>
              <td>{data.totals.builtin.output_tokens}</td>
              <td>{usd(data.totals.builtin.cost_micros)}</td>
            </tr>
            <tr>
              <td>byok（用户自带 key）</td>
              <td>{data.totals.byok.calls}</td>
              <td>{data.totals.byok.input_tokens}</td>
              <td>{data.totals.byok.output_tokens}</td>
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
              <th>builtin 成本</th>
              <th>byok 调用</th>
              <th>byok tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.by_day.length === 0 && (
              <tr>
                <td colSpan={7}>暂无用量上报</td>
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
              <th>builtin 成本</th>
              <th>byok 调用</th>
              <th>byok tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.by_project.length === 0 && (
              <tr>
                <td colSpan={7}>暂无用量上报</td>
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
              <th>builtin 成本</th>
              <th>byok 调用</th>
              <th>byok tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.by_model.length === 0 && (
              <tr>
                <td colSpan={8}>暂无用量上报</td>
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
