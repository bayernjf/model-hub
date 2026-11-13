import { Hono } from 'hono';
import { requireAdmin, type AppEnv } from '../../auth/middleware.js';
import type { HubConfig } from '../../config.js';

/**
 * Tier 0 门户 —— T-D1-01。
 *
 * `/` 要列出的「4 个故事入口」= 4 个本地自用核心服务的入口 + 健康状态。
 * 选择依据（2026-11-13 定，缺口清单/PRD 均未给出权威定义，由 owner 授权自行定）：
 * - Tier 0 分 A 底座 / B 引擎 / C 业务 / D 工具四类，门户先聚合「底座 + 引擎」
 *   这 4 个每天实际在跑的核心服务；业务/工具层后续按需加。
 * - 4 个服务都是 model-hub 的直接或潜在下游：zeus / loom 已在 model-hub 注册
 *   project，agent-world 是实测的模型消费者。
 *
 * 探测 URL 走 tier0-net 共享网络的容器 DNS 名（model-hub 与这些服务同网），
 * 不用宿主 loopback —— 容器内 127.0.0.1 是容器自身，探不到别的服务。
 * 端点可用 HUB_PORTAL_<KEY>_URL 环境变量覆盖，换端口/换部署后不改码。
 */
interface PortalService {
  key: string;
  name: string;
  role: string;
  url: string;
}

const DEFAULT_PORTAL_SERVICES: PortalService[] = [
  {
    key: 'model-hub',
    name: 'Model Hub',
    role: '模型控制面（A 底座）',
    url: 'http://127.0.0.1:8791/healthz',
  },
  {
    key: 'zeus',
    name: 'Zeus',
    role: '决策内核（A 底座）',
    url: 'http://zeus:8787/healthz',
  },
  {
    key: 'loom',
    name: 'Loom',
    role: '工作流（B 引擎）',
    url: 'http://infra-backend-1:8000/healthz',
  },
  {
    key: 'agent-world',
    name: 'Agent World',
    role: 'Agent 执行（B 引擎）',
    url: 'http://agent-world-agent-world-1:8791/api/health',
  },
];

const PROBE_TIMEOUT_MS = 2500;

/** env-key 形如 HUB_PORTAL_ZEUS_URL、HUB_PORTAL_AGENT_WORLD_URL。 */
function envKey(key: string): string {
  return `HUB_PORTAL_${key.toUpperCase().replace(/-/g, '_')}_URL`;
}

export function portalServices(env: NodeJS.ProcessEnv = process.env): PortalService[] {
  return DEFAULT_PORTAL_SERVICES.map((s) => ({
    ...s,
    url: env[envKey(s.key)] ?? s.url,
  }));
}

export interface PortalProbeResult {
  key: string;
  name: string;
  role: string;
  url: string;
  healthy: boolean;
  status: number | null;
  latency_ms: number;
}

/** Probe one service; never throws. Test seam, injectable fetch/timeout. */
export async function probeService(
  svc: PortalService,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PortalProbeResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchImpl(svc.url, { signal: controller.signal });
    clearTimeout(timer);
    return {
      key: svc.key,
      name: svc.name,
      role: svc.role,
      url: svc.url,
      healthy: res.ok,
      status: res.status,
      latency_ms: Date.now() - start,
    };
  } catch {
    return {
      key: svc.key,
      name: svc.name,
      role: svc.role,
      url: svc.url,
      healthy: false,
      status: null,
      latency_ms: Date.now() - start,
    };
  }
}

export function adminPortalRoutes(
  config: HubConfig,
  fetchImpl: typeof fetch = fetch,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use('*', requireAdmin(config));

  routes.get('/portal/status', async (c) => {
    const start = Date.now();
    const services = await Promise.all(portalServices().map((s) => probeService(s, fetchImpl)));
    return c.json({
      checked_at: new Date().toISOString(),
      total_ms: Date.now() - start,
      services,
    });
  });

  return routes;
}
