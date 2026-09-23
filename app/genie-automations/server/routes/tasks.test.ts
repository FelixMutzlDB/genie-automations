import { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { setupReconRoutes } from './recon';
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

  it('records joined activity only for a newly inserted membership', async () => {
    const { handlers, query } = routeHarness([{ task_id: 'vendor-bank-eu', role: 'member' }]);
    const { res } = response();

    await handlers.get('POST /api/tasks/:id/join')?.(request({ params: { id: 'vendor-bank-eu' } }), res);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("SELECT task_id, $1, 'joined', 'success' FROM joined");
    expect(sql).not.toContain("SELECT task_id, $1, 'joined', 'success' FROM eligible");
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
    const handlers = new Map<string, Handler>();
    const query = vi.fn().mockResolvedValue({ rows: [] });
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
    const { res, state } = response();

    await handlers.get('GET /api/proposals')?.(request({ query: { task_id: 'other-org-task' } }), res);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ ok: false, error: 'not a member of this task' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
