import { Application, Request, Response, raw as rawBody } from 'express';
import { z } from 'zod';
import {
  isAlreadyExists,
  MAX_UPLOAD_BYTES,
  newParseId,
  parseRunStatus,
  safeExtension,
  sha256,
  uploadPath,
  validCsvBytes,
} from '../ingest';
import { activeConfigHash, ConfigResolutionError, resolveTaskConfig } from '../config/resolveTaskConfig';

const SCHEMA = 'genie_spike';
const PARSER_VERSION = 'spike-02-v2';

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface UserDb {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}
interface ExecutionResult<T> {
  ok: boolean;
  data?: T;
  error?: unknown;
}
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
const confirmSchema = z
  .object({
    parse_id: idSchema,
    selected_row_ids: z.array(z.number().int().positive()).min(1),
  })
  .strict();

interface CanonicalArtifactRow {
  values: { remittance_id: string; invoice_id: string; amount: string };
  source_row: number;
}

interface IngestArtifact {
  parse_id: string;
  config_version: string;
  status: string;
  rows: CanonicalArtifactRow[];
}

function isReceivablesTask(taskType: string): boolean {
  return taskType === 'reconciliation' || taskType === 'allocation_upsert' || taskType === 'receivables';
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

function auditUnattributedConfirmFailure(actor: string | null, reason: string): void {
  console.warn('Ingest-confirm audit:', { actor: actor ?? 'unverified', status: 'failure', reason });
}

function canonicalArtifact(raw: string, parseId: string, configVersion: string): IngestArtifact {
  const artifact = z
    .object({
      parse_id: z.literal(parseId),
      config_version: z.literal(configVersion),
      status: z.literal('ready'),
      rows: z.array(
        z
          .object({
            source_row: z.number().int().positive(),
            values: z
              .object({
                remittance_id: z.string().min(1),
                invoice_id: z.string().min(1),
                amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
              })
              .passthrough(),
          })
          .passthrough()
      ),
    })
    .passthrough()
    .parse(JSON.parse(raw));
  return artifact;
}

async function recordConfirmActivity(
  db: UserDb,
  input: { taskId: string; actor: string; status: 'success' | 'failure'; proposalIds?: string[]; reason?: string }
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ${SCHEMA}.task_activity(task_id, user_id, action, status, detail, proposal_id)
       VALUES ($1,$2,'ingest_confirm',$3,$4::jsonb,$5)`,
      [
        input.taskId,
        input.actor,
        input.status,
        JSON.stringify(
          input.status === 'success'
            ? { proposal_count: input.proposalIds?.length ?? 0 }
            : { reason: input.reason ?? 'confirmation_failed', proposal_count: input.proposalIds?.length ?? 0 }
        ),
        input.proposalIds?.length === 1 ? input.proposalIds[0] : null,
      ]
    );
  } catch (error) {
    console.error('Failed to record ingest-confirm activity:', error);
  }
}

export function actorOf(req: Request): string | null {
  const actor = req.header('x-forwarded-email')?.trim();
  return actor || null;
}

function friendlyFailure(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export function setupIngestRoutes(appkit: IngestAppKit): void {
  appkit.server.extend((app) => {
    app.post('/api/ingest/:taskId/upload', rawBody({ type: '*/*', limit: MAX_UPLOAD_BYTES }), async (req, res) => {
      try {
        const actor = actorOf(req);
        if (!actor) return friendlyFailure(res, 401, 'We could not verify your identity. Please sign in again.');
        const configVersion = await activeConfigHash(req, req.params.taskId);
        const spec = await resolveTaskConfig(req, req.params.taskId, configVersion, 'allocation_upsert');
        if (spec.settings['ingest_enabled'] !== true)
          return friendlyFailure(res, 409, 'File collection is not enabled here.');

        const encodedName = req.header('x-upload-filename') ?? '';
        let filename = '';
        try {
          filename = decodeURIComponent(encodedName);
        } catch {
          return friendlyFailure(res, 400, 'The file name is invalid.');
        }
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
        const volumeRoot = process.env['DATABRICKS_VOLUME_FILES'];
        if (!volumeRoot) throw new Error('files volume is not configured');

        const userFiles = appkit.files('files').asUser(req);
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
          [parseId, req.params.taskId, actor, relativePath, digest, PARSER_VERSION, configVersion, artifactPath]
        );

        const run = await appkit.jobs('default').runNow({
          args: [
            '--input',
            `${volumeRoot.replace(/\/$/, '')}/${relativePath}`,
            '--artifact',
            `${volumeRoot.replace(/\/$/, '')}/${artifactPath}`,
            '--sha256',
            digest,
            '--parse-id',
            parseId,
            '--filename',
            `original.${extension}`,
          ],
        });
        if (!run.ok || typeof run.data?.run_id !== 'number') throw new Error('parse job was not accepted');
        await db.query(
          `UPDATE ${SCHEMA}.ingest_run SET run_id=$2, status='PENDING', updated_at=now() WHERE parse_id=$1`,
          [parseId, run.data.run_id]
        );
        res.status(202).json({ parse_id: parseId, run_id: run.data.run_id, sha256: digest });
      } catch (error) {
        console.error('Ingest upload failed:', error);
        if (error instanceof ConfigResolutionError) {
          friendlyFailure(res, error.status, error.message);
        } else {
          friendlyFailure(res, 500, 'We could not safely upload and start parsing this file. Nothing was changed.');
        }
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
            WHERE ir.parse_id=$1 AND tm.user_id=$2`,
          [parseId, actor]
        );
        const row = record.rows[0];
        if (!row) return friendlyFailure(res, 403, 'You cannot view this parse run.');
        const runId = Number(row['run_id']);
        const run = await appkit.jobs('default').getRun(runId);
        if (!run.ok || !run.data) throw new Error('parse status unavailable');
        const status = parseRunStatus(run.data);
        if (status === 'succeeded') {
          const output = await appkit.jobs('default').getRunOutput(runId);
          if (!output.ok) throw new Error('parse output unavailable');
        }
        await db.query(`UPDATE ${SCHEMA}.ingest_run SET status=$2, updated_at=now() WHERE parse_id=$1`, [
          parseId,
          status,
        ]);
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
            WHERE ir.parse_id=$1 AND tm.user_id=$2`,
          [parseId, actor]
        );
        const artifact = record.rows[0]?.['artifact_ref'];
        if (typeof artifact !== 'string') return friendlyFailure(res, 403, 'You cannot view this preview.');
        const body = await appkit
          .files('files')
          .asUser(req)
          .read(artifact, { maxSize: 10 * 1024 * 1024 });
        res.json(JSON.parse(body));
      } catch (error) {
        console.error('Ingest preview failed:', error);
        friendlyFailure(res, 409, 'The preview is not ready yet, or its configuration is stale.');
      }
    });

    app.post('/api/ingest/confirm', async (req, res) => {
      const actor = actorOf(req);
      let taskId: string | undefined;
      let userDb: UserDb | undefined;
      const proposalIds: string[] = [];
      try {
        if (!actor) {
          auditUnattributedConfirmFailure(null, 'missing_identity');
          return friendlyFailure(res, 401, 'We could not verify your identity. Please sign in again.');
        }
        userDb = appkit.lakebase.asUser(req);
        const requestBody: unknown = req.body;
        const candidateParseId = idSchema.safeParse(
          requestBody !== null && typeof requestBody === 'object' && 'parse_id' in requestBody
            ? requestBody.parse_id
            : undefined
        );
        if (!candidateParseId.success) {
          auditUnattributedConfirmFailure(actor, 'malformed_request');
          return friendlyFailure(res, 400, 'We could not safely stage those rows. Nothing was changed.');
        }
        const run = await userDb.query(
          `SELECT ir.task_id, ir.artifact_ref, ir.config_version
             FROM ${SCHEMA}.ingest_run ir
            WHERE ir.parse_id=$1 AND ir.requested_by=$2`,
          [candidateParseId.data, actor]
        );
        const runRow = run.rows[0];
        taskId = typeof runRow?.['task_id'] === 'string' ? runRow['task_id'] : undefined;
        if (!taskId) {
          auditUnattributedConfirmFailure(actor, 'unknown_or_other_uploader_parse');
          return friendlyFailure(res, 404, 'That preview is no longer available. Please upload the file again.');
        }
        const body = confirmSchema.parse(req.body);

        const pinnedVersion = runRow?.['config_version'];
        if (typeof pinnedVersion !== 'string') throw new Error('invalid ingest run');
        const spec = await resolveTaskConfig(req, taskId, pinnedVersion, 'allocation_upsert', false);
        if (spec.settings['ingest_enabled'] !== true) {
          await recordConfirmActivity(userDb, { taskId, actor, status: 'failure', reason: 'ingest_disabled' });
          return friendlyFailure(res, 409, 'File collection is not enabled here.');
        }
        if (!isReceivablesTask(spec.taskType)) {
          // TODO: stage_change must become task-type-aware before vendor-bank-detail ingest can be staged safely.
          await recordConfirmActivity(userDb, { taskId, actor, status: 'failure', reason: 'unsupported_task_type' });
          return friendlyFailure(
            res,
            409,
            'Staging from upload is currently available for receivables collection only'
          );
        }

        const artifactRef = runRow?.['artifact_ref'];
        const configVersion = pinnedVersion;
        if (typeof artifactRef !== 'string' || typeof configVersion !== 'string') throw new Error('invalid ingest run');
        const artifactRaw = await appkit
          .files('files')
          .asUser(req)
          .read(artifactRef, { maxSize: 10 * 1024 * 1024 });
        const artifact = canonicalArtifact(artifactRaw, body.parse_id, configVersion);
        const selectedIds = new Set(body.selected_row_ids);
        if (selectedIds.size !== body.selected_row_ids.length) throw new Error('duplicate selected row');
        const selected = artifact.rows.filter((row) => selectedIds.has(row.source_row));
        if (selected.length !== selectedIds.size) throw new Error('selected row is not in canonical artifact');

        const grouped = new Map<string, CanonicalArtifactRow[]>();
        for (const row of selected)
          grouped.set(row.values.remittance_id, [...(grouped.get(row.values.remittance_id) ?? []), row]);
        const stagedDiffs: Array<{
          change_type: 'allocation_upsert';
          diff: { remittance_id: string; allocations: Record<string, unknown>[] };
        }> = [];
        for (const [remittanceId, rows] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
          const allocations: Record<string, unknown>[] = [];
          for (const row of [...rows].sort((left, right) => left.source_row - right.source_row)) {
            const current = await userDb.query(
              `SELECT allocation_id, entity_version FROM ${SCHEMA}.allocation
               WHERE remittance_id=$1 AND invoice_id=$2 ORDER BY allocation_id LIMIT 1`,
              [remittanceId, row.values.invoice_id]
            );
            const existing = current.rows[0];
            allocations.push({
              allocation_id:
                typeof existing?.['allocation_id'] === 'string'
                  ? existing['allocation_id']
                  : `upload-${body.parse_id}-${row.source_row}`,
              invoice_id: row.values.invoice_id,
              amount: row.values.amount,
              ...(typeof existing?.['entity_version'] === 'number' || typeof existing?.['entity_version'] === 'string'
                ? { expected_version: existing['entity_version'] }
                : {}),
            });
          }
          const diff = { remittance_id: remittanceId, allocations };
          stagedDiffs.push({ change_type: 'allocation_upsert', diff });
        }
        const confirmDb = userDb;
        for (const stagedDiff of stagedDiffs) {
          const diffJson = JSON.stringify(stagedDiff.diff);
          const findExisting = () =>
            confirmDb.query(
              `SELECT proposal_id FROM ${SCHEMA}.proposed_changes
                WHERE task_id=$1 AND change_type=$2 AND config_version_hash=$3 AND diff=$4::jsonb
                ORDER BY created_at LIMIT 1`,
              [taskId, stagedDiff.change_type, configVersion, diffJson]
            );
          let existing = await findExisting();
          let proposalId = existing.rows[0]?.['proposal_id'];
          if (typeof proposalId !== 'string') {
            try {
              const staged = await confirmDb.query(`SELECT ${SCHEMA}.stage_change($1,$2,$3,$4::jsonb) AS proposal_id`, [
                taskId,
                stagedDiff.change_type,
                configVersion,
                diffJson,
              ]);
              proposalId = staged.rows[0]?.['proposal_id'];
            } catch (error) {
              if (!isUniqueViolation(error)) throw error;
              existing = await findExisting();
              proposalId = existing.rows[0]?.['proposal_id'];
            }
          }
          if (typeof proposalId !== 'string') throw new Error('stage_change did not return a proposal');
          proposalIds.push(proposalId);
        }
        await recordConfirmActivity(userDb, { taskId, actor, status: 'success', proposalIds });
        res.status(201).json({ proposal_ids: proposalIds });
      } catch (error) {
        if (taskId && actor && userDb) {
          const partial = proposalIds.length > 0;
          await recordConfirmActivity(userDb, {
            taskId,
            actor,
            status: 'failure',
            reason: partial ? 'partially_staged' : 'confirmation_failed',
            proposalIds,
          });
          if (partial) {
            console.error('Ingest confirm partially failed:', error);
            res.status(207).json({
              proposal_ids: proposalIds,
              partial: true,
              message:
                'Some selected rows were staged for review, but the rest could not be staged. You can safely retry to finish the remaining rows.',
            });
            return;
          }
        }
        console.error('Ingest confirm failed:', error);
        const status = error instanceof z.ZodError ? 400 : error instanceof ConfigResolutionError ? error.status : 409;
        friendlyFailure(res, status, 'We could not safely stage those rows. Nothing was changed.');
      }
    });
  });
}
