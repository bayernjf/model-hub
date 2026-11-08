import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import AsyncState from './AsyncState';
import { apiJson, errorText } from './api';
import { tokens, usd } from '../lib/money';

interface Bucket {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  quantity: number;
  amount_micros: number;
}

interface ProjectLine {
  project: string;
  billable_micros: number;
  metered_tokens: number;
  calls: number;
}

interface ModelLine {
  project: string;
  model: string;
  billable_micros: number;
  calls: number;
  metered_calls: number;
}

interface Statement {
  period: string;
  period_start: string;
  period_end: string;
  currency: string;
  billable: Bucket;
  metered_only: Bucket;
  by_project: ProjectLine[];
  by_model: ModelLine[];
  excluded_rows: number;
  unattributed_rows: number;
  note: string;
}

/** Current UTC month, the same default the API applies. */
function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function Buckets({ statement }: { statement: Statement }) {
  return (
    <table>
      <thead>
        <tr>
          <th>来源</th>
          <th>调用</th>
          <th>输入 tokens</th>
          <th>输出 tokens</th>
          <th>缓存读取</th>
          <th>其它单位</th>
          <th>金额 ({statement.currency})</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>builtin（应计）</td>
          <td>{tokens(statement.billable.calls)}</td>
          <td>{tokens(statement.billable.input_tokens)}</td>
          <td>{tokens(statement.billable.output_tokens)}</td>
          <td>{tokens(statement.billable.cache_read_tokens)}</td>
          <td>{statement.billable.quantity > 0 ? tokens(statement.billable.quantity) : '—'}</td>
          <td>{usd(statement.billable.amount_micros)}</td>
        </tr>
        <tr>
          <td>byok（计量不计费）</td>
          <td>{tokens(statement.metered_only.calls)}</td>
          <td>{tokens(statement.metered_only.input_tokens)}</td>
          <td>{tokens(statement.metered_only.output_tokens)}</td>
          <td>{tokens(statement.metered_only.cache_read_tokens)}</td>
          <td>{statement.metered_only.quantity > 0 ? tokens(statement.metered_only.quantity) : '—'}</td>
          <td className="dim">—（自有 key，不进账单）</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function Billing() {
  const [period, setPeriod] = useState(currentPeriod());
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    apiJson<Statement>(`/api/admin/billing?period=${encodeURIComponent(period)}`)
      .then((body) => {
        if (!cancelled) setStatement(body);
      })
      .catch((thrown) => {
        if (!cancelled) setFailure(errorText(thrown));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, attempt]);

  if (loading && !statement) return <AsyncState loading />;
  if (failure) {
    return <AsyncState error={failure} onRetry={() => setAttempt((value) => value + 1)} />;
  }
  if (!statement) return <AsyncState empty emptyText="暂无账单数据。" />;

  // A month with nothing recorded is NOT a bill of zero: the two statements
  // mean different things to whoever reads them. Usage that belongs to an
  // unregistered project is still usage, so it also disqualifies "empty" — the
  // month would otherwise claim there was nothing while rows sit unowned.
  const noBillableCalls =
    statement.billable.calls === 0 && statement.metered_only.calls === 0;
  const empty = noBillableCalls && statement.unattributed_rows === 0;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="toolbar">
        <div className="filters">
          <input
            type="month"
            aria-label="账期"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          />
          <button className="btn btn--ghost" onClick={() => setPeriod(currentPeriod())}>
            本月
          </button>
        </div>
        {loading && <p className="dim">刷新中…</p>}
      </div>

      <section>
        <h2>账期</h2>
        <p className="dim">
          {statement.period_start} ~ {statement.period_end}（UTC 自然月，闭区间）
        </p>
        {empty ? (
          <AsyncState empty emptyText="这个月没有用量记录 —— 不是金额为零，是没有账可出。" />
        ) : noBillableCalls ? (
          <p style={{ fontSize: 15, margin: '8px 0' }}>
            本月有 {tokens(statement.unattributed_rows)} 行用量，但没有一行能归属到已登记的项目
            —— 账单无法为它们出账。先在项目页登记这些项目，再回来核对。
          </p>
        ) : (
          <p style={{ fontSize: 22, fontFamily: 'var(--mono)', margin: '8px 0' }}>
            {usd(statement.billable.amount_micros)}
            <span className="dim" style={{ fontSize: 13, marginLeft: 8 }}>
              （{tokens(statement.billable.calls)} 次调用，byok {tokens(statement.metered_only.calls)} 次仅计量）
            </span>
          </p>
        )}
        {statement.unattributed_rows > 0 && (
          <p className="dim" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} />
            {tokens(statement.unattributed_rows)} 行用量的项目未在 model-hub 登记，无法归属，
            未计入本账单的任何合计
          </p>
        )}
        {statement.excluded_rows > 0 && (
          <p className="dim" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} />
            {statement.excluded_rows} 行属于其它月份，已排除，未计入本期
          </p>
        )}
      </section>

      {!empty && !noBillableCalls && (
        <>
          <section>
            <h2>用量与金额</h2>
            <Buckets statement={statement} />
            <p className="dim">{statement.note}</p>
          </section>

          <section>
            <h2>按项目</h2>
            <table>
              <thead>
                <tr>
                  <th>项目</th>
                  <th>调用</th>
                  <th>应计金额</th>
                  <th>byok tokens（仅计量）</th>
                </tr>
              </thead>
              <tbody>
                {statement.by_project.map((line) => (
                  <tr key={line.project}>
                    <td>{line.project}</td>
                    <td>{tokens(line.calls)}</td>
                    <td>
                      {line.billable_micros === 0 && line.metered_tokens > 0
                        ? '仅计量'
                        : usd(line.billable_micros)}
                    </td>
                    <td>{line.metered_tokens > 0 ? tokens(line.metered_tokens) : '—'}</td>
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
                  <th>调用</th>
                  <th>应计金额</th>
                </tr>
              </thead>
              <tbody>
                {statement.by_model.map((line) => (
                  <tr key={`${line.project}/${line.model}`}>
                    <td>{line.project}</td>
                    <td>{line.model}</td>
                    <td>{tokens(line.calls)}</td>
                    <td>
                      {line.billable_micros === 0 && line.metered_calls > 0
                        ? `仅计量（${tokens(line.metered_calls)} 次）`
                        : usd(line.billable_micros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
