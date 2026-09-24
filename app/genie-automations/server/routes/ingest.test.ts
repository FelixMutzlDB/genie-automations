import { Application, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupIngestRoutes } from './ingest';
import { readFileSync } from 'node:fs';
import { ConfigResolutionError } from '../config/resolveTaskConfig';
import { calculateArtifactHash } from '../ingest/artifactIntegrity';
import { sha256 } from '../ingest';

const resolverMocks = vi.hoisted(() => ({
  activeConfigHash: vi.fn(),
  resolveTaskConfig: vi.fn(),
}));
const imageMocks = vi.hoisted(() => ({ extractImage: vi.fn() }));
vi.mock('../config/resolveTaskConfig', () => ({
  ...resolverMocks,
  ConfigResolutionError: class ConfigResolutionError extends Error {
    constructor(
      public code: string,
      message: string,
      public status = 409
    ) {
      super(message);
    }
  },
}));
vi.mock('../ingest/imageExtraction', () => imageMocks);

beforeEach(() => imageMocks.extractImage.mockReset());

type Handler = (req: Request, res: Response) => Promise<void>;

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

function harness(
  gate: Record<string, unknown>,
  options: {
    exists?: boolean;
    uploadError?: unknown;
    appRows?: Record<string, unknown>[];
    userRows?: Record<string, unknown>[];
    run?: Record<string, unknown>;
    artifact?: string;
    landedBytes?: Buffer;
    storedSha?: string;
  } = {}
) {
  resolverMocks.activeConfigHash.mockReset();
  resolverMocks.resolveTaskConfig.mockReset();
  if (gate['is_member'] === false) {
    resolverMocks.activeConfigHash.mockRejectedValue(
      new ConfigResolutionError('not_authorized', 'Task configuration is unavailable.', 403)
    );
  } else {
    resolverMocks.activeConfigHash.mockResolvedValue('receivables-v1');
  }
  resolverMocks.resolveTaskConfig.mockResolvedValue({
    taskType: typeof gate['task_type'] === 'string' ? gate['task_type'] : 'reconciliation',
    settings: { ingest_enabled: gate['ingest_enabled'] !== false },
  });
  const handlers = new Map<string, Handler>();
  const userQuery = vi.fn().mockResolvedValue({ rows: options.userRows ?? [gate] });
  let insertedSha: unknown;
  const appQuery = vi.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO genie_spike.ingest_run')) insertedSha = params?.[4];
    if (sql.includes('SELECT sha256 FROM genie_spike.ingest_run'))
      return Promise.resolve({ rows: [{ sha256: options.storedSha ?? insertedSha }] });
    return Promise.resolve({ rows: options.appRows ?? [] });
  });
  const upload = options.uploadError
    ? vi.fn().mockRejectedValue(options.uploadError)
    : vi.fn().mockResolvedValue(undefined);
  const exists = vi.fn().mockResolvedValue(options.exists ?? false);
  const read = vi.fn().mockResolvedValue(options.artifact ?? '{"status":"ready"}');
  const landedBytes = options.landedBytes ?? Buffer.from('remittance_id,invoice_id,amount,pay_date\nR1,I1,10.00,2026-01-01\n');
  const download = vi.fn().mockResolvedValue({
    'content-length': landedBytes.length,
    contents: new ReadableStream({ start(controller) { controller.enqueue(landedBytes); controller.close(); } }),
  });
  const runNow = vi.fn().mockResolvedValue({ ok: true, data: { run_id: 77 } });
  const getRun = vi.fn().mockResolvedValue({
    ok: true,
    data: options.run ?? { state: { life_cycle_state: 'RUNNING' } },
  });
  const getRunOutput = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const app = {
    post(path: string, ...callbacks: unknown[]) {
      handlers.set(`POST ${path}`, callbacks[callbacks.length - 1] as Handler);
    },
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
  } as Application;
  const appkit: Parameters<typeof setupIngestRoutes>[0] = {
    lakebase: { query: appQuery, asUser: () => ({ query: userQuery }) },
    files: () => ({ asUser: () => ({ exists, upload, read, download }) }),
    jobs: () => ({ runNow, getRun, getRunOutput }),
    server: { extend: (register) => register(app) },
  };
  setupIngestRoutes(appkit);
  return { handlers, appQuery, userQuery, exists, upload, read, download, runNow, getRun, getRunOutput };
}

function request(email: string | null = 'alice@example.com'): Request {
  return Object.assign({} as Request, {
    params: { taskId: 'receivables-eu' },
    body: Buffer.from('remittance_id,invoice_id,amount,pay_date\nR1,I1,10.00,2026-01-01\n'),
    header: (name: string) =>
      name === 'x-forwarded-email' ? (email ?? undefined) : name === 'x-upload-filename' ? 'input.csv' : undefined,
  });
}

describe('ingest upload route', () => {
  it('uses a generated relative path and starts the mocked parse job', async () => {
    process.env['DATABRICKS_VOLUME_FILES'] = '/Volumes/c/s/v';
    const gate = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
    const { handlers, upload, runNow } = harness(gate);
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), res);
    expect(state.status).toBe(202);
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^receivables-eu\/[a-f0-9]{64}\/original\.csv$/),
      expect.any(Buffer),
      { overwrite: false }
    );
    expect(runNow).toHaveBeenCalledOnce();
  });

  it('does not call Volume or Jobs when membership fails', async () => {
    const { handlers, upload, runNow } = harness({
      is_member: false,
      ingest_enabled: true,
      target_catalog: 'c',
      target_schema: 's',
      target_table: 't',
    });
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
    const { handlers, runNow } = harness(gate, {
      uploadError: Object.assign(new Error('already exists'), { status: 409 }),
    });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), res);
    expect(state.status).toBe(202);
    expect(runNow).toHaveBeenCalledOnce();
  });

  it('reads landed Volume bytes back and rejects a SHA mismatch before inference', async () => {
    const original = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]);
    const tampered = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(9)]);
    const { handlers, download } = harness({}, { landedBytes: tampered });
    const req = request();
    req.body = original;
    req.header = ((name: string) =>
      name === 'x-forwarded-email'
        ? 'alice@example.com'
        : name === 'x-upload-filename'
          ? 'input.png'
          : name === 'x-forwarded-access-token'
            ? 'obo'
            : undefined) as Request['header'];
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(req, res);
    expect(state.status).toBe(500);
    expect(download).toHaveBeenCalledOnce();
    expect(imageMocks.extractImage).not.toHaveBeenCalled();
  });

  it('runs image inference on the SHA-verified Volume bytes', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]);
    imageMocks.extractImage.mockResolvedValue({ status: 'ready', rows: [] });
    const { handlers, download } = harness({}, { landedBytes: png });
    const req = request();
    req.body = Buffer.from(png);
    req.header = ((name: string) =>
      name === 'x-forwarded-email'
        ? 'alice@example.com'
        : name === 'x-upload-filename'
          ? 'input.png'
          : name === 'x-forwarded-access-token'
            ? 'obo'
            : undefined) as Request['header'];
    const result = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(req, result.res);
    expect(result.state.status).toBe(202);
    expect(download).toHaveBeenCalledOnce();
    expect(imageMocks.extractImage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ raw: png, mimeType: 'image/png', sha256: sha256(png) })
    );
  });

  it('rejects when ingest_run stores a different source SHA', async () => {
    const body = Buffer.from('remittance_id,invoice_id,amount,pay_date\nR1,I1,10.00,2026-01-01\n');
    const { handlers, runNow } = harness({}, { landedBytes: body, storedSha: 'f'.repeat(64) });
    const result = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(request(), result.res);
    expect(result.state.status).toBe(500);
    expect(runNow).not.toHaveBeenCalled();
  });

  it('routes from detected image bytes and rejects a conflicting filename', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]);
    const { handlers, upload } = harness({}, { landedBytes: png });
    const req = request();
    req.body = png;
    req.header = ((name: string) =>
      name === 'x-forwarded-email' ? 'alice@example.com' : name === 'x-upload-filename' ? 'input.jpg' : undefined) as Request['header'];
    const { res, state } = response();
    await handlers.get('POST /api/ingest/:taskId/upload')?.(req, res);
    expect(state.status).toBe(415);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('ingest poll and preview routes', () => {
  it('normalizes terminated failed Jobs and does not request their output', async () => {
    const { handlers, appQuery, userQuery, getRunOutput } = harness(
      {},
      {
        appRows: [{ task_id: 'receivables-eu', run_id: 77, status: 'running' }],
        userRows: [{ '?column?': 1 }],
        run: { state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' } },
      }
    );
    const req = request();
    req.params = { parseId: '98e06e87-9d56-4e92-a530-4bd4ad5b1264' };
    const { res, state } = response();
    await handlers.get('GET /api/ingest/:parseId/poll')?.(req, res);
    expect(state.body).toMatchObject({ status: 'failed' });
    expect(userQuery).toHaveBeenCalledWith(expect.stringContaining('FROM genie_spike.task_member'), [
      'receivables-eu',
      'alice@example.com',
    ]);
    expect(appQuery).toHaveBeenCalledWith(expect.stringContaining('FROM genie_spike.ingest_run'), [
      '98e06e87-9d56-4e92-a530-4bd4ad5b1264',
    ]);
    expect(appQuery).not.toHaveBeenCalledWith(expect.stringContaining('genie_spike.task_member'), expect.anything());
    expect(appQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE genie_spike.ingest_run'), [
      '98e06e87-9d56-4e92-a530-4bd4ad5b1264',
      'failed',
    ]);
    expect(getRunOutput).not.toHaveBeenCalled();
  });

  it('reads an authorized preview through the caller-scoped Volume handle', async () => {
    const { handlers, appQuery, userQuery, read } = harness(
      {},
      {
        appRows: [{ task_id: 'receivables-eu', artifact_ref: 'task/digest/parse.preview.json' }],
        userRows: [{ '?column?': 1 }],
        artifact: '{"status":"ready","rows":[]}',
      }
    );
    const req = request();
    req.params = { parseId: '98e06e87-9d56-4e92-a530-4bd4ad5b1264' };
    const { res, state } = response();
    await handlers.get('GET /api/ingest/:parseId/preview')?.(req, res);
    expect(userQuery).toHaveBeenCalledWith(expect.stringContaining('FROM genie_spike.task_member'), [
      'receivables-eu',
      'alice@example.com',
    ]);
    expect(appQuery).toHaveBeenCalledWith(expect.stringContaining('FROM genie_spike.ingest_run'), [
      '98e06e87-9d56-4e92-a530-4bd4ad5b1264',
    ]);
    expect(appQuery).not.toHaveBeenCalledWith(expect.stringContaining('genie_spike.task_member'), expect.anything());
    expect(read).toHaveBeenCalledWith('task/digest/parse.preview.json', { maxSize: 10 * 1024 * 1024 });
    expect(state.body).toMatchObject({ status: 'ready' });
  });

  it('denies preview content when the OBO caller is not a task member', async () => {
    const { handlers, read } = harness(
      {},
      {
        appRows: [{ task_id: 'receivables-eu', artifact_ref: 'task/digest/parse.preview.json' }],
        userRows: [],
      }
    );
    const req = request();
    req.params = { parseId: '98e06e87-9d56-4e92-a530-4bd4ad5b1264' };
    const { res, state } = response();
    await handlers.get('GET /api/ingest/:parseId/preview')?.(req, res);
    expect(state.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});

const PARSE_ID = '98e06e87-9d56-4e92-a530-4bd4ad5b1264';
const SOURCE_SHA = 'b'.repeat(64);
const CANONICAL_ARTIFACT = JSON.stringify({
  parse_id: PARSE_ID,
  config_version: 'receivables-v1',
  status: 'ready',
  sha256: SOURCE_SHA,
  rows: [
    { source_row: 2, values: { remittance_id: 'R-1', invoice_id: 'INV-1', amount: '10.00' } },
    { source_row: 3, values: { remittance_id: 'R-1', invoice_id: 'INV-2', amount: '20.00' } },
  ],
});

function confirmHarness(
  task: Record<string, unknown>,
  options: {
    stageFails?: boolean;
    failStageAt?: number;
    parseOwnedByCaller?: boolean;
    uniqueRace?: boolean;
    artifact?: string;
    parserVersion?: 'spike-02-v2' | 'vision-v1';
  } = {}
) {
  resolverMocks.resolveTaskConfig.mockReset();
  if (task['is_member'] === false) {
    resolverMocks.resolveTaskConfig.mockRejectedValue(
      new ConfigResolutionError('not_authorized', 'Task configuration is unavailable.', 403)
    );
  } else if (!task['target_catalog'] || !task['target_schema'] || !task['target_table']) {
    resolverMocks.resolveTaskConfig.mockRejectedValue(
      new ConfigResolutionError('unbound', 'This automation is awaiting admin configuration.', 409)
    );
  } else {
    resolverMocks.resolveTaskConfig.mockResolvedValue({
      taskType: typeof task['task_type'] === 'string' ? task['task_type'] : 'reconciliation',
      settings: { ingest_enabled: task['ingest_enabled'] !== false },
    });
  }
  const handlers = new Map<string, Handler>();
  const appQuery = vi.fn().mockResolvedValue({ rows: [] });
  const proposalsByDiff = new Map<unknown, string>();
  let raced = false;
  let stageCalls = 0;
  const userQuery = vi.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM genie_spike.ingest_run')) {
      const owned = options.parseOwnedByCaller ?? true;
      return Promise.resolve({
        rows: owned
          ? [{
              task_id: 'receivables-eu',
              artifact_ref: 'artifact.json',
              config_version: 'receivables-v1',
              sha256: SOURCE_SHA,
              parser_version: options.parserVersion ?? 'spike-02-v2',
            }]
          : [],
      });
    }
    if (sql.includes('FROM genie_spike.task t')) return Promise.resolve({ rows: [task] });
    if (sql.includes('FROM genie_spike.allocation')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM genie_spike.proposed_changes')) {
      const existingProposalId = proposalsByDiff.get(params?.[3]);
      return Promise.resolve({ rows: existingProposalId ? [{ proposal_id: existingProposalId }] : [] });
    }
    if (sql.includes('.stage_change(')) {
      stageCalls += 1;
      if (options.stageFails) return Promise.reject(new Error('mock stage failure'));
      if (options.failStageAt === stageCalls) return Promise.reject(new Error('mock later stage failure'));
      if (options.uniqueRace && !raced) {
        raced = true;
        proposalsByDiff.set(params?.[3], 'p-upload');
        return Promise.reject(Object.assign(new Error('duplicate idempotency key'), { code: '23505' }));
      }
      const proposalId = stageCalls === 1 ? 'p-upload' : `p-upload-${stageCalls}`;
      proposalsByDiff.set(params?.[3], proposalId);
      return Promise.resolve({ rows: [{ proposal_id: proposalId }] });
    }
    return Promise.resolve({ rows: [] });
  });
  const app = {
    post(path: string, ...callbacks: unknown[]) {
      handlers.set(`POST ${path}`, callbacks[callbacks.length - 1] as Handler);
    },
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
  } as Application;
  const appkit: Parameters<typeof setupIngestRoutes>[0] = {
    lakebase: { query: appQuery, asUser: () => ({ query: userQuery }) },
    files: () => ({
      asUser: () => ({
        exists: vi.fn(),
        upload: vi.fn(),
        read: vi.fn().mockResolvedValue(options.artifact ?? CANONICAL_ARTIFACT),
        download: vi.fn(),
      }),
    }),
    jobs: () => ({ runNow: vi.fn(), getRun: vi.fn(), getRunOutput: vi.fn() }),
    server: { extend: (register) => register(app) },
  };
  setupIngestRoutes(appkit);
  const req = request();
  req.params = {};
  req.body = { parse_id: PARSE_ID, selected_row_ids: [2] };
  return { handlers, req, userQuery, appQuery };
}

const allowedTask = {
  is_member: true,
  ingest_enabled: true,
  target_catalog: 'catalog',
  target_schema: 'schema',
  target_table: 'target',
  task_type: 'reconciliation',
};

describe('ingest confirm route', () => {
  it('rejects a probabilistic image artifact without an acknowledgement tied to its hash', async () => {
    const artifactValue = {
      parse_id: PARSE_ID,
      config_version: 'receivables-v1',
      status: 'ready',
      sha256: SOURCE_SHA,
      extraction_kind: 'probabilistic_image',
      modality: 'image',
      requires_human_confirmation: true,
      rows: [{ source_row: 2, values: { remittance_id: 'R-1', invoice_id: 'INV-1', amount: '10.00' } }],
    };
    const artifactHash = calculateArtifactHash(artifactValue);
    const artifact = JSON.stringify({ ...artifactValue, artifact_hash: artifactHash });
    const { handlers, req, userQuery } = confirmHarness(allowedTask, { artifact, parserVersion: 'vision-v1' });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(409);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);

    req.body = {
      parse_id: PARSE_ID,
      selected_row_ids: [2],
      human_review_acknowledgement: { parse_id: PARSE_ID, artifact_hash: artifactHash, reviewed: true },
    };
    const accepted = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, accepted.res);
    expect(accepted.state.status).toBe(201);
  });

  it('recomputes the artifact hash and rejects tampering that reuses an old acknowledgement', async () => {
    const original = {
      parse_id: PARSE_ID, config_version: 'receivables-v1', status: 'ready', sha256: SOURCE_SHA,
      extraction_kind: 'probabilistic_image', modality: 'image', requires_human_confirmation: true,
      rows: [{ source_row: 2, values: { remittance_id: 'R-1', invoice_id: 'INV-1', amount: '10.00' } }],
    };
    const oldHash = calculateArtifactHash(original);
    const tampered = JSON.stringify({ ...original, rows: [{ source_row: 2, values: { remittance_id: 'R-1', invoice_id: 'INV-1', amount: '999.00' } }], artifact_hash: oldHash });
    const { handlers, req, userQuery } = confirmHarness(allowedTask, { artifact: tampered, parserVersion: 'vision-v1' });
    req.body = { parse_id: PARSE_ID, selected_row_ids: [2], human_review_acknowledgement: { parse_id: PARSE_ID, artifact_hash: oldHash, reviewed: true } };
    const result = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, result.res);
    expect(result.state.status).toBe(409);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it('cannot stage a cross-foot-rejected image artifact', async () => {
    const rejected = {
      parse_id: PARSE_ID, config_version: 'receivables-v1', status: 'rejected', sha256: SOURCE_SHA,
      extraction_kind: 'probabilistic_image', modality: 'image', requires_human_confirmation: true,
      rows: [], rejected_rows: [{ code: 'IG_CROSS_FOOT_MISMATCH', guidance: 'Totals differ.', source_row: null }], warnings: [],
    };
    const artifact = JSON.stringify({ ...rejected, artifact_hash: calculateArtifactHash(rejected) });
    const { handlers, req, userQuery } = confirmHarness(allowedTask, { artifact, parserVersion: 'vision-v1' });
    req.body = {
      parse_id: PARSE_ID,
      selected_row_ids: [2],
      human_review_acknowledgement: { parse_id: PARSE_ID, artifact_hash: calculateArtifactHash(rejected), reviewed: true },
    };
    const result = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, result.res);
    expect(result.state.status).toBe(409);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it('rejects a server-known vision artifact whose probabilistic markers and hash were stripped', async () => {
    const stripped = JSON.stringify({
      parse_id: PARSE_ID,
      config_version: 'receivables-v1',
      status: 'ready',
      sha256: SOURCE_SHA,
      rows: [{ source_row: 2, values: { remittance_id: 'R-1', invoice_id: 'INV-1', amount: '10.00' } }],
    });
    const { handlers, req, userQuery } = confirmHarness(allowedTask, {
      artifact: stripped,
      parserVersion: 'vision-v1',
    });
    const result = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, result.res);
    expect(result.state.status).toBe(409);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it('rejects browser-supplied amounts or targets', async () => {
    const { handlers, req, userQuery } = confirmHarness(allowedTask);
    req.body = { parse_id: PARSE_ID, selected_row_ids: [2], amount: '999999', target_table: 'attacker_table' };
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(400);
    expect(userQuery).toHaveBeenCalledWith(expect.stringContaining('ir.requested_by=$2'), [
      PARSE_ID,
      'alice@example.com',
    ]);
    expect(userQuery).toHaveBeenCalledWith(
      expect.stringContaining('task_activity'),
      expect.arrayContaining(['failure'])
    );
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it('rejects a same-task parse uploaded by a different member', async () => {
    const { handlers, req, userQuery } = confirmHarness(allowedTask, { parseOwnedByCaller: false });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(404);
    expect(userQuery).toHaveBeenCalledWith(expect.stringContaining('ir.requested_by=$2'), [
      PARSE_ID,
      'alice@example.com',
    ]);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('FROM genie_spike.task t'))).toBe(false);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it('refuses non-receivables tasks and records failure activity', async () => {
    const { handlers, req, userQuery } = confirmHarness({ ...allowedTask, task_type: 'vendor_bank' });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(409);
    expect(state.body).toEqual({ error: 'Staging from upload is currently available for receivables collection only' });
    expect(userQuery).toHaveBeenCalledWith(
      expect.stringContaining('task_activity'),
      expect.arrayContaining(['failure'])
    );
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it.each([
    ['membership', { ...allowedTask, is_member: false }, 403],
    ['ingest', { ...allowedTask, ingest_enabled: false }, 409],
    ['target', { ...allowedTask, target_table: null }, 409],
  ])('enforces %s authorization before staging', async (_label, task, expectedStatus) => {
    const { handlers, req, userQuery } = confirmHarness(task);
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(expectedStatus);
    expect(userQuery.mock.calls.some(([sql]) => String(sql).includes('.stage_change('))).toBe(false);
  });

  it('builds the diff from canonical server rows, stages OBO, and records success activity', async () => {
    const { handlers, req, userQuery } = confirmHarness(allowedTask);
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(201);
    const stageCall = userQuery.mock.calls.find(([sql]) => String(sql).includes('.stage_change('));
    expect(stageCall?.[1]).toEqual([
      'receivables-eu',
      'allocation_upsert',
      'receivables-v1',
      JSON.stringify({
        remittance_id: 'R-1',
        allocations: [
          {
            allocation_id: `upload-${PARSE_ID}-2`,
            invoice_id: 'INV-1',
            amount: '10.00',
          },
        ],
      }),
    ]);
    expect(userQuery).toHaveBeenCalledWith(
      expect.stringContaining('task_activity'),
      expect.arrayContaining(['success'])
    );
  });

  it('returns the same proposal for retries and concurrent unique-key races', async () => {
    const retry = confirmHarness(allowedTask);
    const retryHandler = retry.handlers.get('POST /api/ingest/confirm');
    const first = response();
    const second = response();
    await retryHandler?.(retry.req, first.res);
    await retryHandler?.(retry.req, second.res);
    expect(first.state.body).toEqual({ proposal_ids: ['p-upload'] });
    expect(second.state.body).toEqual({ proposal_ids: ['p-upload'] });
    expect(retry.userQuery.mock.calls.filter(([sql]) => String(sql).includes('.stage_change('))).toHaveLength(1);

    const race = confirmHarness(allowedTask, { uniqueRace: true });
    const raced = response();
    await race.handlers.get('POST /api/ingest/confirm')?.(race.req, raced.res);
    expect(raced.state.status).toBe(201);
    expect(raced.state.body).toEqual({ proposal_ids: ['p-upload'] });
  });

  it('records failure activity when mocked stage_change fails', async () => {
    const { handlers, req, userQuery } = confirmHarness(allowedTask, { stageFails: true });
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(409);
    expect(userQuery).toHaveBeenCalledWith(
      expect.stringContaining('task_activity'),
      expect.arrayContaining(['failure'])
    );
  });

  it('reports proposal ids and logs the truthful outcome when a later remittance fails', async () => {
    const artifact = JSON.stringify({
      parse_id: PARSE_ID,
      config_version: 'receivables-v1',
      status: 'ready',
      sha256: SOURCE_SHA,
      rows: [
        { source_row: 2, values: { remittance_id: 'R-1', invoice_id: 'INV-1', amount: '10.00' } },
        { source_row: 3, values: { remittance_id: 'R-2', invoice_id: 'INV-2', amount: '20.00' } },
      ],
    });
    const { handlers, req, userQuery } = confirmHarness(allowedTask, { artifact, failStageAt: 2 });
    req.body = { parse_id: PARSE_ID, selected_row_ids: [2, 3] };
    const { res, state } = response();
    await handlers.get('POST /api/ingest/confirm')?.(req, res);
    expect(state.status).toBe(207);
    expect(state.body).toEqual({
      proposal_ids: ['p-upload'],
      partial: true,
      message:
        'Some selected rows were staged for review, but the rest could not be staged. You can safely retry to finish the remaining rows.',
    });
    expect(userQuery).toHaveBeenCalledWith(
      expect.stringContaining('task_activity'),
      expect.arrayContaining(['failure', expect.stringContaining('partially_staged'), 'p-upload'])
    );
  });

  it('contains no direct proposal DML or approve/commit shortcut in the ingest route', () => {
    const source = readFileSync(new URL('./ingest.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?\$\{SCHEMA\}\.proposed_changes/i);
    expect(source).not.toContain("state='approved'");
    expect(source).not.toMatch(/\.(?:approve_change|commit_change)\s*\(/);
  });
});
