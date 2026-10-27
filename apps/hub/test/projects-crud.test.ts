import { describe, expect, it } from 'vitest';
import { login, makeTestApp } from './helpers.js';

const validProject = { slug: 'zeus', display_name: 'Zeus' };

function jsonHeaders(cookie: string, extra: Record<string, string> = {}) {
  return { 'Content-Type': 'application/json', Cookie: cookie, ...extra };
}

async function createProject(
  app: ReturnType<typeof makeTestApp>['app'],
  cookie: string,
  project: { slug: string; display_name: string } = validProject,
): Promise<string> {
  const res = await app.request('/api/admin/projects', {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(project),
  });
  const body = (await res.json()) as { project: { id: string } };
  return body.project.id;
}

describe('projects CRUD', () => {
  it('requires authentication', async () => {
    const { app } = makeTestApp();
    expect((await app.request('/api/admin/projects')).status).toBe(401);
  });

  it('creates a project', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const res = await app.request('/api/admin/projects', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify(validProject),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { slug: string; display_name: string; enabled: boolean };
    };
    expect(body.project.slug).toBe('zeus');
    expect(body.project.enabled).toBe(true);
  });

  it('rejects a duplicate slug with 409', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    await createProject(app, cookie);

    const res = await app.request('/api/admin/projects', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify(validProject),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid slug', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const res = await app.request('/api/admin/projects', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ slug: 'Bad Slug!', display_name: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('updates a project', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const id = await createProject(app, cookie);

    const res = await app.request(`/api/admin/projects/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ display_name: 'Zeus Renamed' }),
    });
    const body = (await res.json()) as {
      project: { display_name: string };
    };
    expect(body.project.display_name).toBe('Zeus Renamed');
  });

  it('deletes a project', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const id = await createProject(app, cookie);

    const res = await app.request(`/api/admin/projects/${id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });
});

describe('project tokens', () => {
  it('mints a token shown once and stores only its hash', async () => {
    const { app, db } = makeTestApp();
    const cookie = await login(app);
    const id = await createProject(app, cookie);

    const res = await app.request(`/api/admin/projects/${id}/rotate-token`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as {
      token: string;
      token_view: { token_hint: string; enabled: boolean };
    };

    expect(body.token).toMatch(/^mh_[0-9a-f]{64}$/);
    expect(body.token_view.enabled).toBe(true);
    expect(body.token_view.token_hint).toMatch(/^\*\*\*\*/);

    // The plaintext token never appears in later responses or the database.
    const get = await app.request(`/api/admin/projects/${id}`, {
      headers: { Cookie: cookie },
    });
    expect(await get.text()).not.toContain(body.token);

    const stored = db.prepare('SELECT token_hash FROM tokens').all() as Array<{
      token_hash: string;
    }>;
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(body.token);
  });

  it('keeps multiple enabled tokens during rotation', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const id = await createProject(app, cookie);

    await app.request(`/api/admin/projects/${id}/rotate-token`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    await app.request(`/api/admin/projects/${id}/rotate-token`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });

    const get = await app.request(`/api/admin/projects/${id}`, {
      headers: { Cookie: cookie },
    });
    const detail = (await get.json()) as {
      project: { tokens: Array<{ enabled: boolean }> };
    };
    expect(detail.project.tokens).toHaveLength(2);
    expect(detail.project.tokens.every((t) => t.enabled)).toBe(true);
  });

  it('disables a token', async () => {
    const { app } = makeTestApp();
    const cookie = await login(app);
    const id = await createProject(app, cookie);
    const minted = await (
      await app.request(`/api/admin/projects/${id}/rotate-token`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })
    ).json() as { token_view: { id: string } };

    const res = await app.request(`/api/admin/projects/tokens/${minted.token_view.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });
});

describe('operator read-only access', () => {
  it('lets operator read but returns 403 on writes', async () => {
    const { app } = makeTestApp();
    const operatorCookie = await login(
      app,
      'operator',
      'operator-password-123',
    );

    const read = await app.request('/api/admin/projects', {
      headers: { Cookie: operatorCookie },
    });
    expect(read.status).toBe(200);

    const write = await app.request('/api/admin/projects', {
      method: 'POST',
      headers: jsonHeaders(operatorCookie),
      body: JSON.stringify({ slug: 'atlas', display_name: 'Atlas' }),
    });
    expect(write.status).toBe(403);
  });
});
