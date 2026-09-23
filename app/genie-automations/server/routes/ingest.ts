import { Application, Request, Response, raw as rawBody } from 'express';
import { z } from 'zod';
import {
  ingestGateFailure,
  MAX_UPLOAD_BYTES,
  newParseId,
  safeExtension,
  sha256,
  uploadPath,
  type IngestTaskGate,
} from '../ingest';

const SCHEMA = 'genie_spike';
const PARSER_VERSION = 'spike-02-v2';
const CONFIG_VERSION = 'receivables-v1';

interface QueryResult { rows: Record<string, unknown>[] }
interface UserDb { query(text: string, params?: unknown[]): Promise<QueryResult> }
interface ExecutionResult<T> { ok: boolean; data?: T; error?: unknown }
export interface IngestAppKit {
  lakebase: { asUser(req: Request): UserDb };
  files(name: string): {
    asUser(req: Request): { upload(path: string, body: Buffer, options: { overwrite: boolean }): Promise<void> };
    read(path: string, options?: { maxSize?: number }): Promise<string>;
  };
  jobs(name: string): {
    runNow(params: { args: string[] }): Promise<ExecutionResult<{ run_id?: number }>>;
    getRun(runId: number): Promise<ExecutionResult<Record<string, unknown>>>;
    getRunOutput(runId: number): Promise<ExecutionResult<Record<string, unknown>>>;
  };
  server: { extend(fn: (app: Application) => void): void };
}

export function isIngestAppKit(value: object): value is IngestAppKit {
  return ['lakebase', 'files', 'jobs', 'server'].every((key) => key in value);
}

const idSchema = z.string().uuid();

function actorOf(req: Request): string {
  return req.header('x-forwarded-email') ?? 'unknown';
}

function friendlyFailure(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

async function authorizedTask(appkit: IngestAppKit, req: Request, taskId: string): Promise<IngestTaskGate | undefined> {
  const result = await appkit.lakebase.asUser(req).query(
    `SELECT EXISTS (
       SELECT 1 FROM ${SCHEMA}.task_member tm
        WHERE tm.task_id = t.task_id AND tm.user_id = $2
     ) AS is_member,
     t.ingest_enabled, t.target_catalog, t.target_schema, t.target_table
     FROM ${SCHEMA}.task t
     WHERE t.task_id = $1 AND t.status = 'active'`,
    [taskId, actorOf(req)]
  );
  return result.rows[0] as unknown as IngestTaskGate | undefined;
}

function lifecycle(run: Record<string, unknown>): string {
  const state = run['state'];
  if (!state || typeof state !== 'object') return 'PENDING';
  const value = (state as Record<string, unknown>)['life_cycle_state'];
  return typeof value === 'string' ? value : 'PENDING';
}

export function setupIngestRoutes(appkit: IngestAppKit): void {
  appkit.server.extend((app) => {
    app.post('/api/ingest/:taskId/upload', rawBody({ type: '*/*', limit: MAX_UPLOAD_BYTES }), async (req, res) => {
      try {
        const task = await authorizedTask(appkit, req, req.params.taskId);
        const failure = ingestGateFailure(task);
        if (failure === 'not_member') return friendlyFailure(res, 403, 'You are not a member of this automation.');
        if (failure === 'ingest_disabled') return friendlyFailure(res, 409, 'File collection is not enabled here.');
        if (failure === 'target_unbound') return friendlyFailure(res, 409, 'This automation needs a complete target binding.');

        const encodedName = req.header('x-upload-filename') ?? '';
        let filename = '';
        try { filename = decodeURIComponent(encodedName); } catch { return friendlyFailure(res, 400, 'The file name is invalid.'); }
        const extension = safeExtension(filename);
        if (!extension) return friendlyFailure(res, 415, 'Choose a CSV or XLSX file.');
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return friendlyFailure(res, 400, 'The file is empty.');
        if (extension === 'xlsx' && !req.body.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) {
          return friendlyFailure(res, 415, 'That file is not a valid XLSX workbook.');
        }

        const digest = sha256(req.body);
        const relativePath = uploadPath(req.params.taskId, digest, extension);
        const parseId = newParseId();
        const artifactPath = `${req.params.taskId}/${digest}/${parseId}.preview.json`;
        const volumeRoot = process.env['DATABRICKS_VOLUME_UPLOADS'];
        if (!volumeRoot) throw new Error('uploads volume is not configured');

        const userFiles = appkit.files('uploads').asUser(req);
        await userFiles.upload(relativePath, req.body, { overwrite: false });

        const db = appkit.lakebase.asUser(req);
        await db.query(
          `INSERT INTO ${SCHEMA}.ingest_run
             (parse_id, task_id, requested_by, volume_path, sha256, parser_version, config_version, status, artifact_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'UPLOADED',$8)
           ON CONFLICT (parse_id) DO NOTHING`,
          [parseId, req.params.taskId, actorOf(req), relativePath, digest, PARSER_VERSION, CONFIG_VERSION, artifactPath]
        );

        const run = await appkit.jobs('parse').runNow({
          args: [
            '--input', `${volumeRoot.replace(/\/$/, '')}/${relativePath}`,
            '--artifact', `${volumeRoot.replace(/\/$/, '')}/${artifactPath}`,
            '--sha256', digest,
            '--parse-id', parseId,
            '--filename', `original.${extension}`,
          ],
        });
        if (!run.ok || typeof run.data?.run_id !== 'number') throw new Error('parse job was not accepted');
        await db.query(`UPDATE ${SCHEMA}.ingest_run SET run_id=$2, status='PENDING', updated_at=now() WHERE parse_id=$1`, [parseId, run.data.run_id]);
        res.status(202).json({ parse_id: parseId, run_id: run.data.run_id, sha256: digest });
      } catch (error) {
        console.error('Ingest upload failed:', error);
        friendlyFailure(res, 500, 'We could not safely upload and start parsing this file. Nothing was changed.');
      }
    });

    app.get('/api/ingest/:parseId/poll', async (req, res) => {
      try {
        const parseId = idSchema.parse(req.params.parseId);
        const db = appkit.lakebase.asUser(req);
        const record = await db.query(
          `SELECT ir.run_id, ir.status FROM ${SCHEMA}.ingest_run ir
             JOIN ${SCHEMA}.task_member tm ON tm.task_id=ir.task_id
            WHERE ir.parse_id=$1 AND tm.user_id=$2`, [parseId, actorOf(req)]
        );
        const row = record.rows[0];
        if (!row) return friendlyFailure(res, 403, 'You cannot view this parse run.');
        const runId = Number(row['run_id']);
        const run = await appkit.jobs('parse').getRun(runId);
        if (!run.ok || !run.data) throw new Error('parse status unavailable');
        const status = lifecycle(run.data);
        if (status === 'TERMINATED') await appkit.jobs('parse').getRunOutput(runId);
        await db.query(`UPDATE ${SCHEMA}.ingest_run SET status=$2, updated_at=now() WHERE parse_id=$1`, [parseId, status]);
        res.json({ parse_id: parseId, run_id: runId, status });
      } catch (error) {
        console.error('Ingest poll failed:', error);
        friendlyFailure(res, 500, 'We could not check the parser status. Please try again.');
      }
    });

    app.get('/api/ingest/:parseId/preview', async (req, res) => {
      try {
        const parseId = idSchema.parse(req.params.parseId);
        const record = await appkit.lakebase.asUser(req).query(
          `SELECT ir.artifact_ref FROM ${SCHEMA}.ingest_run ir
             JOIN ${SCHEMA}.task_member tm ON tm.task_id=ir.task_id
            WHERE ir.parse_id=$1 AND tm.user_id=$2`, [parseId, actorOf(req)]
        );
        const artifact = record.rows[0]?.['artifact_ref'];
        if (typeof artifact !== 'string') return friendlyFailure(res, 403, 'You cannot view this preview.');
        const body = await appkit.files('uploads').read(artifact, { maxSize: 10 * 1024 * 1024 });
        res.json(JSON.parse(body));
      } catch (error) {
        console.error('Ingest preview failed:', error);
        friendlyFailure(res, 409, 'The preview is not ready yet, or its configuration is stale.');
      }
    });
  });
}
