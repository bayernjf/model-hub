import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { createApp, type AppOverrides } from '../src/app.js';
import { loadConfig, type HubConfig } from '../src/config.js';
import { migrateUp } from '../src/db/migrate.js';
import { openDatabase } from '../src/db/open.js';

export interface TestApp {
  app: Hono;
  db: DatabaseSync;
  config: HubConfig;
}

export function makeTestApp(
  extraEnv: Record<string, string> = {},
  overrides: AppOverrides = {},
): TestApp {
  const config = loadConfig({
    HUB_MASTER_KEY: 'master-key-0123456789abcdef',
    HUB_ADMIN_PASSWORD: 'owner-password-123',
    HUB_OPERATOR_PASSWORD: 'operator-password-123',
    ...extraEnv,
  });
  const db = openDatabase(':memory:');
  migrateUp(db);
  return { app: createApp(config, db, overrides), db, config };
}

// Log in and return the Cookie header value (e.g. "hub_session=...").
export async function login(
  app: Hono,
  username: string = 'owner',
  password: string = 'owner-password-123',
): Promise<string> {
  const res = await app.request('/api/admin/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.get('Set-Cookie')?.split(';')[0] ?? '';
}
