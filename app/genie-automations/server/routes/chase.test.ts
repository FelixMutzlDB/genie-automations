import { readFileSync } from 'node:fs';
import { Application, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupChaseRoutes } from './chase';

type Handler = (req: Request, res: Response) => Promise<void>;

function request(method: string, body: unknown = {}, role = 'owner'): Request {
  const req: Partial<Request> = {
    method,
    body,
    params: { id: 'receivables-eu' },
    header: ((name: string) => (name === 'x-forwarded-email' ? `${role}@example.com` : undefined)) as Request['header'],
  };
  return req as Request;
}

function response() {
  const state: { status: number; body?: unknown } = { status: 200 };
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

function harness(query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    put(path: string, handler: Handler) {
      handlers.set(`PUT ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
  } as Application;
  setupChaseRoutes({
    lakebase: { asUser: () => ({ query }) },
    server: { extend: (register) => register(app) },
  });
  return handlers;
}

const validConfig = {
  enabled: true,
  cadence: 'daily',
  due_offset_days: 2,
  default_due_at: null,
  approach_offsets: [7, 2],
  post_due_offsets: [1, 7, 14],
  quiet_hours_start: '18:00',
  quiet_hours_end: '08:00',
  timezone: 'Europe/Berlin',
};

describe('chase routes', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('allows an owner to save config through the OBO database and logs activity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: 'owner', task_type: 'receivables' }] })
      .mockResolvedValueOnce({ rows: [{ task_id: 'receivables-eu', ...validConfig }] });
    const handlers = harness(query);
    const { res, state } = response();
    await handlers.get('PUT /api/tasks/:id/reminders/config')?.(request('PUT', validConfig), res);

    expect(state.status).toBe(200);
    expect(String(query.mock.calls[1]?.[0])).toContain('save_task_schedule_config');
  });

  it('returns 403 to a non-owner before any schedule write', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ role: 'member', task_type: 'receivables' }] });
    const handlers = harness(query);
    const { res, state } = response();
    await handlers.get('PUT /api/tasks/:id/reminders/config')?.(request('PUT', validConfig, 'member'), res);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: 'Only the automation owner or an administrator can edit reminders.' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('task_activity');
    expect(String(query.mock.calls[1]?.[0])).not.toContain('task_schedule_config');
  });

  it('allows a configured administrator through the same edit boundary', async () => {
    vi.stubEnv('CONFIG_ADMIN_PRINCIPALS', 'admin@example.com');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: null, task_type: 'receivables' }] })
      .mockResolvedValueOnce({ rows: [{ task_id: 'receivables-eu', ...validConfig }] });
    const handlers = harness(query);
    const { res, state } = response();
    await handlers.get('PUT /api/tasks/:id/reminders/config')?.(request('PUT', validConfig, 'admin'), res);
    expect(state.status).toBe(200);
  });

  it('dry-run returns approaching and overdue items and writes nothing', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: 'member', task_type: 'receivables' }] })
      .mockResolvedValueOnce({
        rows: [
          { item_reference: 'REM-1', state: 'approaching_due', outstanding_amount: '10.00' },
          { item_reference: 'REM-2', state: 'overdue', outstanding_amount: '20.00' },
        ],
      });
    const handlers = harness(query);
    const { res, state } = response();
    await handlers.get('GET /api/tasks/:id/reminders/preview')?.(request('GET', {}, 'member'), res);

    expect(state.body).toMatchObject({
      counts: { total: 2, approaching: 1, overdue: 1 },
      items: [{ item_reference: 'REM-1' }, { item_reference: 'REM-2' }],
    });
    expect(query.mock.calls).toHaveLength(2);
    for (const [sql] of query.mock.calls) expect(String(sql)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CALL)\b/i);
  });

  it('scopes evaluation to the requested task when the user owns two tasks', async () => {
    const query = vi.fn((sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
      const call = query.mock.calls.length;
      if (call === 1) return Promise.resolve({ rows: [{ role: 'owner', task_type: 'receivables' }] });
      if (call === 2) return Promise.resolve({ rows: [{ ...validConfig }] });
      if (call === 3) {
        const correctlyScoped = sql.includes('WHERE r.task_id=$1') && params?.[0] === 'receivables-eu';
        return Promise.resolve({
          rows: correctlyScoped
            ? [{ item_reference: 'TASK-A-REM', accounting_period: '2026-09', remaining_amount: '10.00' }]
            : [
                { item_reference: 'TASK-A-REM', accounting_period: '2026-09', remaining_amount: '10.00' },
                { item_reference: 'TASK-B-REM', accounting_period: '2026-09', remaining_amount: '20.00' },
              ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const handlers = harness(query);
    const { res, state } = response();
    await handlers.get('POST /api/tasks/:id/reminders/evaluate')?.(request('POST'), res);

    expect(state.body).toEqual({ item_count: 1 });
    expect(String(query.mock.calls[2]?.[0])).toContain('WHERE r.task_id=$1');
    expect(query.mock.calls[2]?.[1]).toEqual(['receivables-eu']);
    const savedReferences = query.mock.calls
      .filter(([sql]) => String(sql).includes('save_chase_item_status'))
      .map(([, params]) => params?.[1]);
    expect(savedReferences).toEqual(['TASK-A-REM']);
    expect(savedReferences).not.toContain('TASK-B-REM');
  });

  it('transitions missing outstanding items to resolved for only the requested task', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ role: 'owner', task_type: 'receivables' }] })
      .mockResolvedValueOnce({ rows: [{ ...validConfig }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ resolved_count: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    const handlers = harness(query);
    const { res, state } = response();
    await handlers.get('POST /api/tasks/:id/reminders/evaluate')?.(request('POST'), res);

    expect(state.body).toEqual({ item_count: 0 });
    expect(String(query.mock.calls[3]?.[0])).toContain('resolve_missing_chase_items');
    expect(query.mock.calls[3]?.[1]).toEqual(['receivables-eu', []]);
  });

  it('contains no money-mutation capability', () => {
    const source = readFileSync(new URL('./chase.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/stage_change|proposed_changes|approve_change|commit_change|guarded/i);
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?genie_spike\.(?:remittance|allocation)\b/i);
  });
});

describe('chase migration', () => {
  const migration = readFileSync(new URL('../../migrations/003_chase_reminders.sql', import.meta.url), 'utf8');

  it('creates the two additive tables with their natural key and state model', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS genie_spike.task_schedule_config');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS genie_spike.chase_item_status');
    expect(migration).toContain('PRIMARY KEY (task_id, item_reference)');
    expect(migration).toContain("'scheduled', 'approaching_due', 'overdue', 'resolved'");
    expect(migration).toContain('REFERENCES genie_spike.task(task_id)');
  });

  it('does not alter the guarded money mutation core', () => {
    expect(migration).not.toMatch(/stage_change|proposed_changes|approve_change|commit_change|guarded/i);
    expect(migration).not.toMatch(/\bALTER\s+(?:TABLE|FUNCTION)\s+genie_spike\.(?:remittance|allocation)/i);
  });

  it('uses OBO-callable security-definer chase functions for configured admins without broad write grants', () => {
    expect(migration).toContain('save_task_schedule_config');
    expect(migration).toContain('LANGUAGE sql SECURITY DEFINER');
    expect(migration).toContain('p_timezone,session_user,now()');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION genie_spike.save_task_schedule_config');
    expect(migration).toContain(
      'GRANT SELECT ON genie_spike.task_schedule_config, genie_spike.chase_item_status TO :"obo_role"'
    );
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON genie_spike.task_schedule_config, genie_spike.chase_item_status FROM :"obo_role"'
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON genie_spike.task_schedule_config, genie_spike.chase_item_status TO :"obo_role"'
    );
  });
});
