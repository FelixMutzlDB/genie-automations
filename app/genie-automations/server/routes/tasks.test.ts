import { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
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
  it('lists active tasks in the current user organization through OBO', async () => {
    const task = { task_id: 'receivables-eu', role: 'owner', member_count: 1 };
    const { handlers, query } = routeHarness([task]);
    const { res, state } = response();

    await handlers.get('GET /api/tasks')?.(request(), res);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE t.status = 'active'"), ['alice@example.com']);
    expect(state.body).toEqual([task]);
  });

  it('joins a task idempotently and records activity', async () => {
    const { handlers, query } = routeHarness([{ task_id: 'vendor-bank-eu' }]);
    const { res, state } = response();

    await handlers.get('POST /api/tasks/:id/join')?.(request({ params: { id: 'vendor-bank-eu' } }), res);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'alice@example.com',
      'vendor-bank-eu',
    ]);
    expect(state.body).toEqual({ ok: true, role: 'member' });
  });
});
