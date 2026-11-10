#!/usr/bin/env node
/**
 * Prints model-hub token usage from GET /api/admin/costs.
 *
 * model-hub does not proxy upstream calls: projects pull base_url + credential
 * from /pub/v1/models and report their own usage back to /pub/v1/usage. So this
 * only shows what the project clients actually reported — a project that never
 * reports stays invisible here, and cost_micros stays 0 unless the model carries
 * a per-token pricing entry (subscription plans have none).
 *
 * Usage:
 *   node scripts/usage-report.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Credentials come from .env (HUB_ADMIN_PASSWORD, HUB_PORT) — never hardcoded.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(here, '..', '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env is optional when the values are already exported.
  }
  return env;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--from' || key === '--to') {
      out[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const env = loadEnv();
const base = `http://127.0.0.1:${env.HUB_PORT || process.env.HUB_PORT || '8791'}`;
const password = env.HUB_ADMIN_PASSWORD || process.env.HUB_ADMIN_PASSWORD;
const username = env.HUB_OWNER_USERNAME || 'owner';

if (!password) {
  console.error('HUB_ADMIN_PASSWORD missing from .env');
  process.exit(1);
}

async function login() {
  const res = await fetch(`${base}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error('login returned no session cookie');
  return cookie.split(';')[0];
}

function money(micros) {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function row(cells, widths) {
  return cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
}

function section(title, rows, columns, pick) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('  (none)');
    return;
  }
  const data = rows.map(pick);
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...data.map((d) => String(d[i]).length)),
  );
  console.log('  ' + row(columns, widths));
  for (const d of data) console.log('  ' + row(d, widths));
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const qs = new URLSearchParams();
  if (args.from) qs.set('from', args.from);
  if (args.to) qs.set('to', args.to);

  const cookie = await login();
  const res = await fetch(`${base}/api/admin/costs${qs.size ? `?${qs}` : ''}`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`costs failed: HTTP ${res.status} ${await res.text()}`);
  const d = await res.json();

  const window = args.from || args.to ? `${args.from || '…'} → ${args.to || '…'}` : 'all time';
  console.log(`model-hub usage — window: ${window}`);
  console.log(`source: ${base}/api/admin/costs`);

  const t = d.totals?.builtin ?? {};
  const byok = d.totals?.byok ?? {};
  console.log(
    `\ntotal (builtin): ${t.calls ?? 0} calls, in ${t.input_tokens ?? 0} / out ${t.output_tokens ?? 0} tokens, ${money(t.cost_micros ?? 0)}`,
  );
  console.log(
    `total (byok):    ${byok.calls ?? 0} calls, in ${byok.input_tokens ?? 0} / out ${byok.output_tokens ?? 0} tokens (customer key, never billed)`,
  );

  section(
    'by project',
    d.by_project ?? [],
    ['project', 'calls', 'input', 'output', 'cost'],
    (r) => [r.project, r.builtin.calls, r.builtin.input_tokens, r.builtin.output_tokens, money(r.builtin.cost_micros)],
  );

  section(
    'by model',
    d.by_model ?? [],
    ['model', 'calls', 'input', 'output', 'cost'],
    (r) => [r.model, r.builtin.calls, r.builtin.input_tokens, r.builtin.output_tokens, money(r.builtin.cost_micros)],
  );

  section(
    'by day',
    d.by_day ?? [],
    ['day', 'calls', 'input', 'output', 'cost'],
    (r) => [r.day, r.builtin.calls, r.builtin.input_tokens, r.builtin.output_tokens, money(r.builtin.cost_micros)],
  );

  if ((t.cost_micros ?? 0) === 0 && (t.input_tokens ?? 0) + (t.output_tokens ?? 0) > 0) {
    console.log(
      '\nnote: tokens were recorded but cost is 0 — this model has no per-token pricing\n' +
        '      entry (subscription plans carry none), so cost is not derivable here.',
    );
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
