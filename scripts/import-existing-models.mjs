#!/usr/bin/env node
/**
 * W7-2 one-time importer: mirror each project's legacy built-in models/env
 * into the hub, then reconcile expected vs actual.
 *
 * Source inventory (frozen at migration time, do not edit without a new
 * migration round):
 *   - zeus : ZEUS_LLM_* in zeus/.env           -> agnes-2.5-flash (text)
 *   - loom : LOOM_LLM_* / LOOM_CONTENT_* in loom/backend/.env.shell
 *            + ai_models registry               -> agnes-2.5-flash (text,
 *            scene routing), agnes-3.0-flash (text, content base),
 *            agnes-image-2.5-flash (image), agnes-video-2.5-flash (video)
 *   - growth-os: no model env (W7-1 opt-in only), nothing to import
 *
 * Both projects point at the same gateway: https://apihub.agnes-ai.com/v1
 * (preset "agnes"). Provider creation itself is NOT automated: the gateway
 * key is a secret and must be entered in the admin UI first. The script
 * imports preset model overlays under that existing provider and enables
 * them, then prints a reconciliation report.
 *
 * Usage:
 *   node scripts/import-existing-models.mjs [--hub http://localhost:8791]
 *                                           [--cookie "admin-session=..."]
 *                                           [--dry-run]
 */

const HUB =
  process.argv.find((a) => a.startsWith('--hub='))?.split('=')[1] ??
  'http://localhost:8791';
const COOKIE =
  process.argv.find((a) => a.startsWith('--cookie='))?.split('=')[1] ?? '';
const DRY_RUN = process.argv.includes('--dry-run');

const AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const AGNES_PRESET = 'agnes';

// project -> required preset model ids on the shared agnes gateway.
const INVENTORY = [
  { project: 'zeus', models: ['agnes-2-5-flash'] },
  {
    project: 'loom',
    models: [
      'agnes-2-5-flash',
      'agnes-3-0-flash',
      'agnes-image-2-5-flash',
      'agnes-video-2-5-flash',
    ],
  },
];

async function api(path, method = 'GET', body) {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(COOKIE ? { Cookie: COOKIE } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function summary(expected, actual) {
  const rows = [];
  for (const { project, models } of expected) {
    for (const presetId of models) {
      const overlay = actual.find((m) => m.preset_model_id === presetId);
      rows.push({
        project,
        preset_model_id: presetId,
        overlay: overlay ? overlay.model : '(missing)',
        enabled: overlay ? overlay.enabled === 1 || overlay.enabled === true : false,
      });
    }
  }
  return rows;
}

async function main() {
  console.log(`hub: ${HUB}${DRY_RUN ? ' (dry-run)' : ''}`);

  const providers = (await api('/api/admin/providers')).providers ?? [];
  const provider = providers.find((p) => p.base_url === AGNES_BASE_URL);
  if (!provider) {
    console.error(
      `Provider for ${AGNES_BASE_URL} not found. Create it in the admin UI first ` +
        '(key stays out of scripts), then re-run.',
    );
    process.exit(1);
  }
  console.log(`provider: ${provider.name} (${provider.id})`);

  let models = (await api('/api/admin/models')).models ?? [];
  const requiredIds = [...new Set(INVENTORY.flatMap((r) => r.models))];

  // 1. Import preset overlays that are still missing.
  const existing = new Set(
    models
      .filter((m) => m.provider_id === provider.id)
      .map((m) => m.preset_model_id),
  );
  const missing = requiredIds.filter((id) => !existing.has(id));
  if (missing.length > 0) {
    console.log(`importing missing preset models: ${missing.join(', ')}`);
    if (!DRY_RUN) {
      await api(
        `/api/admin/providers/${provider.id}/models/import`,
        'POST',
        { preset_provider_id: AGNES_PRESET, model_ids: missing },
      );
      models = (await api('/api/admin/models')).models ?? [];
    }
  } else {
    console.log('no missing preset overlays to import');
  }

  // 2. Enable required overlays that are still disabled.
  for (const presetId of requiredIds) {
    const overlay = models.find(
      (m) => m.provider_id === provider.id && m.preset_model_id === presetId,
    );
    if (!overlay) continue;
    if (overlay.enabled === 1 || overlay.enabled === true) continue;
    console.log(`enabling ${overlay.model} (${overlay.id})`);
    if (!DRY_RUN) {
      await api(`/api/admin/models/${overlay.id}`, 'PATCH', { enabled: true });
    }
  }

  // 3. Reconciliation.
  const final = DRY_RUN
    ? models
    : ((await api('/api/admin/models')).models ?? []);
  const rows = summary(INVENTORY, final);
  console.log('\n=== reconciliation ===');
  for (const row of rows) {
    const status = row.overlay === '(missing)' ? 'MISSING' : row.enabled ? 'OK' : 'DISABLED';
    console.log(
      `[${status.padEnd(8)}] ${row.project.padEnd(7)} ${row.preset_model_id.padEnd(26)} -> ${row.overlay}`,
    );
  }
  const bad = rows.filter((r) => r.overlay === '(missing)' || !r.enabled);
  console.log(
    bad.length === 0
      ? '\nresult: all expected models present and enabled'
      : `\nresult: ${bad.length} rows need attention`,
  );
  process.exit(bad.length === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
