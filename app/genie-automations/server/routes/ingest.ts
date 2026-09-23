import { Application, Request, Response, raw as rawBody } from 'express';
import { z } from 'zod';
import {
  ingestGateFailure,
  isAlreadyExists,
  MAX_UPLOAD_BYTES,
  newParseId,
  parseRunStatus,
  safeExtension,
  sha256,
  uploadPath,
  validCsvBytes,
  type IngestTaskGate,
} from '../ingest';

const SCHEMA = 'genie_spike';
const PARSER_VERSION = 'spike-02-v2';
const CONFIG_VERSION = 'receivables-v1';

interface QueryResult { rows: Record<string, unknown>[] }
interface UserDb { query(text: string, params?: unknown[]): Promise<QueryResult> }
interface ExecutionResult<T> { ok: boolean; data?: T; error?: unknown }
export interface IngestAppKit {
  lakebase: UserDb & { asUser(req: Request): UserDb };
  files(name: string): {
    asUser(req: Request): {
      exists(path: string): Promise<boolean>;
      upload(path: string, body: Buffer, options: { overwrite: boolean }): Promise<void>;
      read(path: string, options?: { maxSize?: number }): Promise<string>;
    };
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

export function actorOf(req: Request): string | null {
  const actor = req.header('x-forwarded-email')?.trim();
  return actor || null;
}

function friendlyFailure(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

async function authorizedTask(appkit: IngestAppKit, req: Request, taskId: string, actor: string): Promise<IngestTaskGate | undefined> {
  const result = await appkit.lakebase.asUser(req).query(
    `SELECT EXISTS (
       SELECT 1 FROM ${SCHEMA}.task_member tm
        WHERE tm.task_id = t.task_id AND tm.user_id = $2
     ) AS is_member,
     t.ingest_enabled, t.target_catalog, t.target_schema, t.target_table
     FROM ${SCHEMA}.task t
     WHERE t.task_id = $1 AND t.status = 'active'`,
    [taskId, actor]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    is_member: row['is_member'] === true,
    ingest_enabled: row['ingest_enabled'] === true,
    target_catalog: typeof row['target_catalog'] === 'string' ? row['target_catalog'] : null,
    target_schema: typeof row['target_schema'] === 'string' ? row['target_schema'] : null,
    target_table: typeof row['target_table'] === 'string' ? row['target_table'] : null,
  };
}

export function setupIngestRoutes(appkit: IngestAppKit): void {
  appkit.server.extend((app) => {
    app.post('/api/ingest/:taskId/upload', rawBody({ type: '*/*', limit: MAX_UPLOAD_BYTES }), async (req, res) => {
      try {
        const actor = actorOf(req);
        if (!actor) return friendlyFailure(res, 401, 'We could not verify your identity. Please sign in again.');
        const task = await authorizedTask(appkit, req, req.params.taskId, actor);
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
        if (extension === 'csv' && !validCsvBytes(req.body)) {
          return friendlyFailure(res, 415, 'That CSV contains binary or unsupported content.');
        }

        const digest = sha256(req.body);
        const relativePath = uploadPath(req.params.taskId, digest, extension);
        const parseId = newParseId();
        const artifactPath = `${req.params.taskId}/${digest}/${parseId}.preview.json`;
        const volumeRoot = process.env['DATABRICKS_VOLUME_UPLOADS'];
        if (!volumeRoot) throw new Error('uploads volume is not configured');

        const userFiles = appkit.files('uploads').asUser(req);
        if (!(await userFiles.exists(relativePath))) {
          try {
            await userFiles.upload(relativePath, req.body, { overwrite: false });
          } catch (error) {
            if (!isAlreadyExists(error)) throw error;
          }
        }

        const db = appkit.lakebase;
        await db.query(
          `INSERT INTO ${SCHEMA}.ingest_run
             (parse_id, task_id, requested_by, volume_path, sha256, parser_version, config_version, status, artifact_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'UPLOADED',$8)
           ON CONFLICT (parse_id) DO NOTHING`,
          [parseId, req.params.taskId, actor, relativePath, digest, PARSER_VERSION, CONFIG_VERSION, artifactPath]
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
        const actor = actorOf(req);
        if (!actor) return friendlyFailure(res, 401, 'We could not verify your identity. Please sign in again.');
        const parseId = idSchema.parse(req.params.parseId);
        const db = appkit.lakebase;
        const record = await db.query(
          `SELECT ir.run_id, ir.status FROM ${SCHEMA}.ingest_run ir
             JOIN ${SCHEMA}.task_member tm ON tm.task_id=ir.task_id
            WHERE ir.parse_id=$1 AND tm.user_id=$2`, [parseId, actor]
        );
        const row = record.rows[0];
        if (!row) return friendlyFailure(res, 403, 'You cannot view this parse run.');
        const runId = Number(row['run_id']);
        const run = await appkit.jobs('parse').getRun(runId);
        if (!run.ok || !run.data) throw new Error('parse status unavailable');
        const status = parseRunStatus(run.data);
        if (status === 'succeeded') {
          const output = await appkit.jobs('parse').getRunOutput(runId);
          if (!output.ok) throw new Error('parse output unavailable');
        }
        await db.query(`UPDATE ${SCHEMA}.ingest_run SET status=$2, updated_at=now() WHERE parse_id=$1`, [parseId, status]);
        res.json({
          parse_id: parseId,
          run_id: runId,
          status,
          ...(status === 'failed' ? { message: 'The parser could not finish safely. Nothing was changed.' } : {}),
        });
      } catch (error) {
        console.error('Ingest poll failed:', error);
        friendlyFailure(res, 500, 'We could not check the parser status. Please try again.');
      }
    });

    app.get('/api/ingest/:parseId/preview', async (req, res) => {
      try {
        const actor = actorOf(req);
        if (!actor) return friendlyFailure(res, 401, 'We could not verify your identity. Please sign in again.');
        const parseId = idSchema.parse(req.params.parseId);
        const record = await appkit.lakebase.query(
          `SELECT ir.artifact_ref FROM ${SCHEMA}.ingest_run ir
             JOIN ${SCHEMA}.task_member tm ON tm.task_id=ir.task_id
            WHERE ir.parse_id=$1 AND tm.user_id=$2`, [parseId, actor]
        );
        const artifact = record.rows[0]?.['artifact_ref'];
        if (typeof artifact !== 'string') return friendlyFailure(res, 403, 'You cannot view this preview.');
        const body = await appkit.files('uploads').asUser(req).read(artifact, { maxSize: 10 * 1024 * 1024 });
        res.json(JSON.parse(body));
      } catch (error) {
        console.error('Ingest preview failed:', error);
        friendlyFailure(res, 409, 'The preview is not ready yet, or its configuration is stale.');
      }
    });
  });
}
