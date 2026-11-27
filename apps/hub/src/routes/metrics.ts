import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import {
  ModelHubMetricsService,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusMetrics,
} from '../observability/metrics.js';

/**
 * Prometheus scrapes `/metrics` from the local tier0-net. Deliberately
 * outside `/api` and outside every auth guard: it exposes aggregate usage
 * counts only, never prompt content, key material or project identity.
 */
export function metricsRoutes(db: DatabaseSync): Hono {
  const routes = new Hono();
  const service = new ModelHubMetricsService(db);

  routes.get('/metrics', (c) => {
    const snapshot = service.getMetrics();
    return c.text(renderPrometheusMetrics(snapshot), 200, {
      'Content-Type': PROMETHEUS_CONTENT_TYPE,
      'Cache-Control': 'no-store',
    });
  });

  return routes;
}
