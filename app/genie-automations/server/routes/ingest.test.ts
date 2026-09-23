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

function harness(
  gate: Record<string, unknown>,
  options: {
    exists?: boolean;
    uploadError?: unknown;
    appRows?: Record<string, unknown>[];
    run?: Record<string, unknown>;
    artifact?: string;
  } = {}
) {
  const handlers = new Map<string, Handler>();
  const userQuery = vi.fn().mockResolvedValue({ rows: [gate] });
  const appQuery = vi.fn().mockResolvedValue({ rows: options.appRows ?? [] });
  const upload = options.uploadError
    ? vi.fn().mockRejectedValue(options.uploadError)
    : vi.fn().mockResolvedValue(undefined);
  const exists = vi.fn().mockResolvedValue(options.exists ?? false);
  const read = vi.fn().mockResolvedValue(options.artifact ?? '{"status":"ready"}');
  const runNow = vi.fn().mockResolvedValue({ ok: true, data: { run_id: 77 } });
  const getRun = vi.fn().mockResolvedValue({
    ok: true,
    data: options.run ?? { state: { life_cycle_state: 'RUNNING' } },
  });
  const getRunOutput = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const app = {
    post(path: string, ...callbacks: unknown[]) { handlers.set(`POST ${path}`, callbacks[callbacks.length - 1] as Handler); },
    get(path: string, handler: Handler) { handlers.set(`GET ${path}`, handler); },
  } as Application;
  const appkit: Parameters<typeof setupIngestRoutes>[0] = {
    lakebase: { query: appQuery, asUser: () => ({ query: userQuery }) },
    files: () => ({ asUser: () => ({ exists, upload, read }) }),
    jobs: () => ({ runNow, getRun, getRunOutput }),
    server: { extend: (register) => register(app) },
  };
  setupIngestRoutes(appkit);
  return { handlers, appQuery, exists, upload, read, runNow, getRun, getRunOutput };
}

function request(email: string | null = 'alice@example.com'): Request {
  return Object.assign({} as Request, {
    params: { taskId: 'receivables-eu' },
    body: Buffer.from('remittance_id,invoice_id,amount,pay_date\nR1,I1,10.00,2026-01-01\n'),
    header: (name: string) => name === 'x-forwarded-email' ? (email ?? undefined) : name === 'x-upload-filename' ? 'input.csv' : undefined,
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

  it('fails closed before database, Volume, or Job access without a verified identity', async () => {
    const { handlers, appQuery, upload, runNow } = harness({});
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(null), res);
    expect(state.status).toBe(401);
    expect(appQuery).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(runNow).not.toHaveBeenCalled();
  });

  it('rejects binary content presented as CSV before landing bytes', async () => {
    const gate = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
    const { handlers, upload, runNow } = harness(gate);
    const req = request();
    req.body = Buffer.from([0, 1, 2, 3]);
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(req, res);
    expect(state.status).toBe(415);
    expect(upload).not.toHaveBeenCalled();
    expect(runNow).not.toHaveBeenCalled();
  });

  it('deduplicates an existing immutable digest path and still starts a new parse run', async () => {
    const gate = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
    const { handlers, upload, runNow } = harness(gate, { exists: true });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), res);
    expect(state.status).toBe(202);
    expect(upload).not.toHaveBeenCalled();
    expect(runNow).toHaveBeenCalledOnce();
  });

  it('treats an upload race that reports already-exists as immutable dedup', async () => {
    const gate = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
    const { handlers, runNow } = harness(gate, { uploadError: Object.assign(new Error('already exists'), { status: 409 }) });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), res);
    expect(state.status).toBe(202);
    expect(runNow).toHaveBeenCalledOnce();
  });
});

describe('ingest poll and preview routes', () => {
  it('normalizes terminated failed Jobs and does not request their output', async () => {
    const { handlers, getRunOutput } = harness({}, {
      appRows: [{ run_id: 77, status: 'running' }],
      run: { state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' } },
    });
    const req = request();
    req.params = { parseId: '98e06e87-9d56-4e92-a530-4bd4ad5b1264' };
    const { res, state } = response();
    await handlers.get('GET /api/ingest/:parseId/poll')?.(req, res);
    expect(state.body).toMatchObject({ status: 'failed' });
    expect(getRunOutput).not.toHaveBeenCalled();
  });

  it('reads an authorized preview through the caller-scoped Volume handle', async () => {
    const { handlers, read } = harness({}, {
      appRows: [{ artifact_ref: 'task/digest/parse.preview.json' }],
      artifact: '{"status":"ready","rows":[]}',
    });
    const req = request();
    req.params = { parseId: '98e06e87-9d56-4e92-a530-4bd4ad5b1264' };
    const { res, state } = response();
    await handlers.get('GET /api/ingest/:parseId/preview')?.(req, res);
    expect(read).toHaveBeenCalledWith('task/digest/parse.preview.json', { maxSize: 10 * 1024 * 1024 });
    expect(state.body).toMatchObject({ status: 'ready' });
  });
});
