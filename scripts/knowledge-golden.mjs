#!/usr/bin/env node
/**
 * Knowledge-base golden retrieval evaluation (D5-3 / W3-6b).
 *
 * Two phases, both idempotent:
 *   --ingest  upload every markdown doc under apps/hub/knowledge-seed/docs to
 *             the owner project (default: loom), skipping titles already there
 *   --eval    run golden.json questions and compute hit@5 against citations
 *
 * Default (no flag) runs ingest then eval. Exit 1 when the hit rate is below
 * the pass bar unless --no-gate is set. The admin password is read from
 * HUB_ADMIN_PASSWORD — never hard-code it; the base URL defaults to the local
 * hub.
 *
 * Usage:
 *   HUB_ADMIN_PASSWORD=... node scripts/knowledge-golden.mjs
 *   HUB_ADMIN_PASSWORD=... node scripts/knowledge-golden.mjs --eval --no-gate
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = join(REPO, "apps", "hub", "knowledge-seed");
const DOCS_DIR = join(SEED_DIR, "docs");
const BASE = process.env.HUB_BASE_URL?.replace(/\/+$/, "") ?? "http://127.0.0.1:8791";
const USER = process.env.HUB_ADMIN_USER ?? "owner";
const PASSWORD = process.env.HUB_ADMIN_PASSWORD;
const golden = JSON.parse(readFileSync(join(SEED_DIR, "golden.json"), "utf8"));
const OWNER_SLUG = golden.owner_slug;
const TOP_K = golden.top_k;
const PASS_BAR = golden.pass_bar;
const args = new Set(process.argv.slice(2));
const DO_INGEST = args.has("--ingest") || (!args.has("--eval") && !args.has("--ingest"));
const DO_EVAL = args.has("--eval") || (!args.has("--eval") && !args.has("--ingest"));
const GATE = !args.has("--no-gate");

function fail(message) {
  console.error(`knowledge-golden: ${message}`);
  process.exit(1);
}

async function main() {
  if (!PASSWORD) fail("HUB_ADMIN_PASSWORD is required");

  // Login: the cookie jar keeps the admin session across calls.
  const login = await fetch(`${BASE}/api/admin/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!login.ok) fail(`login failed: HTTP ${login.status}`);
  const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  const auth = { "content-type": "application/json", cookie };
  const post = (path, body) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const get = (path) => fetch(`${BASE}${path}`, { headers: { cookie } });

  const projects = await (await get("/api/admin/projects")).json();
  const owner = projects.projects?.find((p) => p.slug === OWNER_SLUG)?.id;
  if (!owner) fail(`owner project '${OWNER_SLUG}' not found`);

  if (DO_INGEST) {
    const existing = await (await get(`/api/admin/knowledge/documents?owner=${owner}`)).json();
    const have = new Set((existing.documents ?? []).map((d) => d.title));
    const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")).sort();
    let added = 0;
    for (const file of files) {
      const title = file.replace(/\.md$/, "");
      if (have.has(title)) {
        console.log(`skip  ${title} (already ingested)`);
        continue;
      }
      const text = readFileSync(join(DOCS_DIR, file), "utf8");
      const res = await post("/api/admin/knowledge/ingest", {
        owner, title, text, mime: "text/markdown", source: "knowledge-seed",
      });
      if (!res.ok) fail(`ingest ${title} failed: HTTP ${res.status} ${await res.text()}`);
      const body = await res.json();
      added += 1;
      console.log(`ingest ${title} (chunks: ${body.chunk_count ?? "?"})`);
    }
    console.log(`ingest phase: ${added} new, ${files.length - added} skipped`);
  }

  if (!DO_EVAL) return;

  const rows = [];
  let hits = 0;
  for (const item of golden.questions) {
    const res = await post("/api/admin/knowledge/query", {
      owner, query: item.q, top_k: TOP_K, rerank: false,
    });
    if (!res.ok) fail(`query '${item.id}' failed: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    const titles = (body.citations ?? []).map((c) => c.title);
    const hit = titles.includes(item.expect_title);
    if (hit) hits += 1;
    rows.push({ id: item.id, hit, top: titles.slice(0, 3).join(" | ") || "(none)" });
  }
  const rate = hits / golden.questions.length;
  for (const r of rows) console.log(`${r.hit ? "HIT " : "MISS"}  ${r.id}  ${r.top}`);
  console.log(`\nhit@${TOP_K}: ${hits}/${golden.questions.length} = ${(rate * 100).toFixed(1)}% (bar ${(PASS_BAR * 100).toFixed(0)}%)`);
  if (GATE && rate < PASS_BAR) fail(`retrieval hit rate below bar`);
  console.log("PASS");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
