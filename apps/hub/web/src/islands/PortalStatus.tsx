import { useCallback, useEffect, useState } from 'react';
import AsyncState from './AsyncState';
import { apiJson, errorText } from './api';

interface PortalService {
  key: string;
  name: string;
  role: string;
  url: string;
  healthy: boolean;
  status: number | null;
  latency_ms: number;
}

interface PortalStatusResponse {
  checked_at: string;
  total_ms: number;
  services: PortalService[];
}

export default function PortalStatus() {
  const [data, setData] = useState<PortalStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiJson<PortalStatusResponse>('/api/admin/portal/status'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const services = data?.services ?? [];
  const healthy = services.filter((s) => s.healthy).length;

  return (
    <AsyncState loading={loading} error={error} onRetry={load}>
      <div className="portal">
        <div className="portal-summary">
          <span className="portal-summary__count">
            {healthy}/{services.length} 在线
          </span>
          {data && (
            <span className="portal-summary__time">
              探测于 {new Date(data.checked_at).toLocaleTimeString('zh-CN')} ·{' '}
              {data.total_ms}ms
            </span>
          )}
        </div>
        <ul className="portal-grid">
          {services.map((s) => (
            <li className="portal-card" key={s.key}>
              <div className="portal-card__head">
                <span
                  className={
                    s.healthy ? 'portal-dot portal-dot--ok' : 'portal-dot portal-dot--down'
                  }
                />
                <span className="portal-card__name">{s.name}</span>
                <span className="portal-card__role">{s.role}</span>
              </div>
              <div className="portal-card__meta">
                <span
                  className={
                    s.healthy
                      ? 'portal-status portal-status--ok'
                      : 'portal-status portal-status--down'
                  }
                >
                  {s.healthy ? `在线 · HTTP ${s.status}` : '离线'}
                </span>
                <span className="portal-latency">{s.latency_ms}ms</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </AsyncState>
  );
}
