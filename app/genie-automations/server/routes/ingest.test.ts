import { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { setupIngestRoutes } from './ingest';

type Handler = (req: Request, res: Response) => Promise<void>;

function response() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.body = body; return res; },
  } as Response;
  return { res, state };
}

function harness(gate: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [gate] })
    .mockResolvedValue({ rows: [] });
  const upload = vi.fn().mockResolvedValue(undefined);
  const runNow = vi.fn().mockResolvedValue({ ok: true, data: { run_id: 77 } });
  const app = {
    post(path: string, ...callbacks: unknown[]) { handlers.set(`POST ${path}`, callbacks[callbacks.length - 1] as Handler); },
    get(path: string, handler: Handler) { handlers.set(`GET ${path}`, handler); },
  } as Application;
  const appkit: Parameters<typeof setupIngestRoutes>[0] = {
    lakebase: { asUser: () => ({ query }) },
    files: () => ({ asUser: () => ({ upload }), read: vi.fn() }),
    jobs: () => ({ runNow, getRun: vi.fn(), getRunOutput: vi.fn() }),
    server: { extend: (register) => register(app) },
  };
  setupIngestRoutes(appkit);
  return { handlers, upload, runNow };
}

function request(): Request {
  return Object.assign({} as Request, {
    params: { taskId: 'receivables-eu' },
    body: Buffer.from('remittance_id,invoice_id,amount,pay_date\nR1,I1,10.00,2026-01-01\n'),
    header: (name: string) => name === 'x-forwarded-email' ? 'alice@example.com' : name === 'x-upload-filename' ? 'input.csv' : undefined,
  });
}

describe('ingest upload route', () => {
  it('uses a generated relative path and starts the mocked parse job', async () => {
    process.env['DATABRICKS_VOLUME_UPLOADS'] = '/Volumes/c/s/v';
    const gate = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
    const { handlers, upload, runNow } = harness(gate);
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), res);
    expect(state.status).toBe(202);
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^receivables-eu\/[a-f0-9]{64}\/original\.csv$/), expect.any(Buffer), { overwrite: false });
    expect(runNow).toHaveBeenCalledOnce();
  });

  it('does not call Volume or Jobs when membership fails', async () => {
    const { handlers, upload, runNow } = harness({ is_member: false, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), res);
    expect(state.status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
    expect(runNow).not.toHaveBeenCalled();
  });
});
