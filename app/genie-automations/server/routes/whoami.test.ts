import { Application, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupWhoamiRoute } from './whoami';

type Handler = (req: Request, res: Response) => Promise<void>;

function harness(rows: Record<string, unknown>[]) {
  let handler: Handler | undefined;
  setupWhoamiRoute({
    lakebase: {
      query: vi.fn(),
      asUser: () => ({ query: vi.fn().mockResolvedValue({ rows }) }),
    },
    server: {
      extend: (register) =>
        register({
          get(_path: string, routeHandler: Handler) {
            handler = routeHandler;
          },
        } as Application),
    },
  });
  return handler;
}

function response() {
  const state: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      state.body = body;
      return res;
    },
  } as Response;
  return {
    state,
    res,
  };
}

describe('/api/whoami', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns only whether the canonical identity is a configured admin', async () => {
    vi.stubEnv('CONFIG_ADMIN_PRINCIPALS', 'other@example.com, Alice@Example.com ');
    const handler = harness([{ session_user: 'pg-user@example.com', current_user: 'current-role' }]);
    const req = {
      header: (name: string) => (name === 'x-forwarded-email' ? 'alice@example.com' : undefined),
    } as Request;
    const { res, state } = response();

    await handler?.(req, res);

    expect(state.body?.is_admin).toBe(true);
    expect(state.body).not.toHaveProperty('admin_principals');
    expect(JSON.stringify(state.body)).not.toContain('other@example.com');
    expect(Object.keys(state.body ?? {}).filter((key) => key.includes('admin'))).toEqual(['is_admin']);
  });

  it('uses the forwarded email as the canonical identity', async () => {
    const handler = harness([{ session_user: 'pg-user@example.com', current_user: 'current-role' }]);
    const req = {
      header: (name: string) => (name === 'x-forwarded-email' ? 'alice@example.com' : undefined),
    } as Request;
    const { res, state } = response();

    await handler?.(req, res);

    expect(state.body).toMatchObject({
      identity: 'alice@example.com',
      forwarded_email: 'alice@example.com',
      pg_session_user: 'pg-user@example.com',
      verdict: 'L0_full_obo',
    });
  });

  it('falls back to the PostgreSQL session user', async () => {
    const handler = harness([{ session_user: 'pg-user@example.com', current_user: 'current-role' }]);
    const req = { header: () => undefined } as unknown as Request;
    const { res, state } = response();

    await handler?.(req, res);

    expect(state.body?.identity).toBe('pg-user@example.com');
  });

  it('falls back to the PostgreSQL session user for a blank forwarded email', async () => {
    const handler = harness([{ session_user: 'pg-user@example.com', current_user: 'current-role' }]);
    const req = { header: () => '   ' } as unknown as Request;
    const { res, state } = response();

    await handler?.(req, res);

    expect(state.body?.identity).toBe('pg-user@example.com');
    expect(state.body?.forwarded_email).toBe('   ');
  });
});
