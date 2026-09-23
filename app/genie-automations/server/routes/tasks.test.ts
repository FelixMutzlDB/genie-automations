import { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { clientSafeError, clientSafeSqlstate, GENERIC_SERVER_ERROR, setupReconRoutes } from './recon';
import { setupTaskRoutes } from './tasks';

type Handler = (req: Request, res: Response) => Promise<void>;

function routeHarness(rows: Record<string, unknown>[] = []) {
  const handlers = new Map<string, Handler>();
  const query = vi.fn().mockResolvedValue({ rows });
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
  } as Application;
  const appkit: Parameters<typeof setupTaskRoutes>[0] = {
    lakebase: { asUser: () => ({ query }) },
    server: { extend: (register) => register(app) },
  };
  setupTaskRoutes(appkit);
  return { handlers, query };
}

function reconHarness(query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
  } as Application;
  setupReconRoutes({
    lakebase: { asUser: () => ({ query }) },
    server: { extend: (register) => register(app) },
  });
  return handlers;
}

function request(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    params: {},
    query: {},
    header: (name: string) => (name === 'x-forwarded-email' ? 'alice@example.com' : undefined),
    ...overrides,
  } as Request;
}

function response() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as Response;
  return { res, state };
}

describe('error response shaping', () => {
  it('logs raw exception details but returns only the generic client message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(clientSafeError(new Error('SQLSTATE GA003: private database details'))).toBe(GENERIC_SERVER_ERROR);
    expect(log).toHaveBeenCalledWith('Request failed:', expect.any(Error));

    log.mockRestore();
  });

  it('keeps only recognized database error codes', () => {
    expect(clientSafeSqlstate('GA003')).toBe('GA003');
    expect(clientSafeSqlstate('42501')).toBe('42501');
    expect(clientSafeSqlstate('ECONNRESET')).toBe('error');
    expect(clientSafeSqlstate({ internal: true })).toBe('error');
  });
});

describe('task routes', () => {
  it('lists active demo tasks, including tasks the user could join', async () => {
    const task = { task_id: 'receivables-eu', role: 'owner', member_count: 1 };
    const { handlers, query } = routeHarness([task]);
    const { res, state } = response();

    await handlers.get('GET /api/tasks')?.(request(), res);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("t.org_id = 'org-demo'"), ['alice@example.com']);
    expect(state.body).toEqual([task]);
  });

  it('lets a user join their first active task without prior membership', async () => {
    const { handlers, query } = routeHarness([{ task_id: 'vendor-bank-eu', role: 'member' }]);
    const { res, state } = response();

    await handlers.get('POST /api/tasks/:id/join')?.(request({ params: { id: 'vendor-bank-eu' } }), res);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'alice@example.com',
      'vendor-bank-eu',
    ]);
    expect(state.body).toEqual({ ok: true, role: 'member' });
  });

  it('records exactly one joined activity across repeated joins', async () => {
    let isMember = false;
    let joinedActivityInserts = 0;
    const query = vi.fn((sql: string) => {
      const insertedMembership = !isMember;
      const activityUsesInsertedMembership = sql.includes("'joined', 'success' FROM joined");
      if (activityUsesInsertedMembership ? insertedMembership : true) joinedActivityInserts += 1;
      isMember = true;
      return Promise.resolve({ rows: [{ task_id: 'vendor-bank-eu', role: 'member' }] });
    });
    const handlers = new Map<string, Handler>();
    const app = {
      get(path: string, handler: Handler) {
        handlers.set(`GET ${path}`, handler);
      },
      post(path: string, handler: Handler) {
        handlers.set(`POST ${path}`, handler);
      },
    } as Application;
    setupTaskRoutes({
      lakebase: { asUser: () => ({ query }) },
      server: { extend: (register) => register(app) },
    });
    const handler = handlers.get('POST /api/tasks/:id/join');

    await handler?.(request({ params: { id: 'vendor-bank-eu' } }), response().res);
    await handler?.(request({ params: { id: 'vendor-bank-eu' } }), response().res);

    expect(query).toHaveBeenCalledTimes(2);
    expect(joinedActivityInserts).toBe(1);
  });

  it('keeps an owner role when the owner calls join', async () => {
    const { handlers } = routeHarness([{ task_id: 'receivables-eu', role: 'owner' }]);
    const { res, state } = response();

    await handlers.get('POST /api/tasks/:id/join')?.(request({ params: { id: 'receivables-eu' } }), res);

    expect(state.body).toEqual({ ok: true, role: 'owner' });
  });

  it('returns the role stored in the membership row', async () => {
    const { handlers } = routeHarness([{ task_id: 'vendor-bank-eu', role: 'owner' }]);
    const { res, state } = response();

    await handlers.get('POST /api/tasks/:id/join')?.(request({ params: { id: 'vendor-bank-eu' } }), res);

    expect(state.body).toMatchObject({ role: 'owner' });
  });

  it('rejects an unauthorized task_id before listing proposals', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const handlers = reconHarness(query);
    const { res, state } = response();

    await handlers.get('GET /api/proposals')?.(request({ query: { task_id: 'other-org-task' } }), res);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ ok: false, error: 'not a member of this task' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['/api/approve', '/api/commit'])('rejects missing proposals before guarded %s', async (path) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const handlers = reconHarness(query);
    const { res, state } = response();

    await handlers.get(`POST ${path}`)?.(request({ body: { proposal_id: 'does-not-exist' } }), res);

    expect(state.status).toBe(404);
    expect(state.body).toEqual({ ok: false, error: 'proposal not found' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain('SELECT task_id');
  });

  it('rejects unauthorized task_id on chat before calling the model', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const handlers = reconHarness(query);
    const { res, state } = response();

    await handlers.get('POST /api/chat')?.(request({ body: { message: 'hello', task_id: 'other-org-task' } }), res);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ ok: false, error: 'not a member of this task' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['/api/approve', '/api/commit'])('rejects unauthorized proposals before guarded %s', async (path) => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ task_id: 'other-org-task' }] })
      .mockResolvedValueOnce({ rows: [] });
    const handlers = reconHarness(query);
    const { res, state } = response();

    await handlers.get(`POST ${path}`)?.(request({ body: { proposal_id: 'proposal-other-org' } }), res);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ ok: false, error: 'not a member of this task' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some((call) => String(call[0]).includes(`${path.slice(5)}_change`))).toBe(false);
  });
});
