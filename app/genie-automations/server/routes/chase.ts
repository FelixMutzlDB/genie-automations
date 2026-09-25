import { Application, Request, Response } from 'express';
import { z } from 'zod';
import { dueAtFor, nextCheckAt, stateAt, type ChasePolicy } from '../chase';
import { isConfigAdmin } from './whoami';

const SCHEMA = 'genie_spike';
const RECEIVABLE_TASK_TYPES = new Set(['receivables', 'allocation_upsert', 'reconciliation']);

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface UserDb {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}
interface ChaseAppKit {
  lakebase: { asUser(req: Request): UserDb };
  server: { extend(fn: (app: Application) => void): void };
}

const scheduleSchema = z
  .object({
    enabled: z.boolean(),
    cadence: z.enum(['daily', 'weekly']),
    due_offset_days: z.number().int().min(-31).max(366),
    default_due_at: z.iso.datetime({ offset: true }).nullable(),
    approach_offsets: z.array(z.number().int().positive().max(366)).min(1).max(10),
    post_due_offsets: z.array(z.number().int().positive().max(366)).min(1).max(10),
    quiet_hours_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    quiet_hours_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict();

const batchActionSchema = z
  .object({
    action: z.enum(['approve', 'archive']),
    note: z.string().trim().max(1000).default(''),
    confirmed: z.literal(true),
  })
  .strict();

function actorOf(req: Request): string {
  return (req.header('x-forwarded-email') ?? '').trim().toLowerCase();
}

function friendlyFailure(res: Response): void {
  res.status(500).json({ error: 'Reminder settings are unavailable right now. Please try again.' });
}

function isSharedLedgerOwnerConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const dbError = error as { code?: unknown; message?: unknown };
  return (
    dbError.code === '42501' &&
    typeof dbError.message === 'string' &&
    dbError.message.includes('shared receivables ledger already has an enabled chase schedule')
  );
}

async function logFailure(appkit: ChaseAppKit, req: Request, action: string): Promise<void> {
  const actor = actorOf(req);
  if (!actor) return;
  try {
    await appkit.lakebase.asUser(req).query(
      // Chase activity intentionally shares the product-wide task_activity feed.
      `INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
       SELECT t.task_id,$2,$3,'failure',jsonb_build_object('reason','request_failed')
         FROM ${SCHEMA}.task t
         LEFT JOIN ${SCHEMA}.task_member tm ON tm.task_id=t.task_id AND lower(tm.user_id)=lower($2)
        WHERE t.task_id=$1 AND (tm.user_id IS NOT NULL OR $4::boolean)`,
      [req.params.id, actor, action, isConfigAdmin(actor)]
    );
  } catch {
    // The original humanized response takes precedence when activity storage is unavailable.
  }
}

async function accessFor(
  db: UserDb,
  taskId: string,
  actor: string
): Promise<{ role: string | null; taskType: string } | null> {
  const result = await db.query(
    `SELECT tm.role, t.task_type
       FROM ${SCHEMA}.task t
       LEFT JOIN ${SCHEMA}.task_member tm ON tm.task_id=t.task_id AND lower(tm.user_id)=lower($2)
      WHERE t.task_id=$1 AND t.status='active'`,
    [taskId, actor]
  );
  const row = result.rows[0];
  return row && typeof row['task_type'] === 'string'
    ? { role: typeof row['role'] === 'string' ? row['role'] : null, taskType: row['task_type'] }
    : null;
}

async function requireMember(
  db: UserDb,
  req: Request,
  res: Response
): Promise<{ actor: string; role: string | null; taskType: string } | null> {
  const actor = actorOf(req);
  if (!actor) {
    res.status(403).json({ error: 'You do not have access to reminders for this automation.' });
    return null;
  }
  const access = await accessFor(db, String(req.params.id), actor);
  if (!access || (!access.role && !isConfigAdmin(actor))) {
    res.status(403).json({ error: 'You do not have access to reminders for this automation.' });
    return null;
  }
  return { actor, ...access };
}

function canManage(actor: string, role: string | null): boolean {
  return role === 'owner' || isConfigAdmin(actor);
}

function policyOf(row: Record<string, unknown>): ChasePolicy {
  return {
    cadence: row['cadence'] === 'weekly' ? 'weekly' : 'daily',
    dueOffsetDays: Number(row['due_offset_days']),
    defaultDueAt: typeof row['default_due_at'] === 'string' ? row['default_due_at'] : null,
    approachOffsets: Array.isArray(row['approach_offsets']) ? row['approach_offsets'].map(Number) : [],
    postDueOffsets: Array.isArray(row['post_due_offsets']) ? row['post_due_offsets'].map(Number) : [],
    timezone: String(row['timezone']),
  };
}

async function evaluate(db: UserDb, taskId: string, actor: string, now: Date): Promise<number> {
  const configResult = await db.query(`SELECT * FROM ${SCHEMA}.get_task_schedule_config($1)`, [taskId]);
  const config = configResult.rows[0];
  if (!config) throw new Error('schedule_missing');
  const policy = policyOf(config);
  const source = await db.query(
    `SELECT r.remittance_id AS item_reference, r.period AS accounting_period,
            r.total_amount-COALESCE(SUM(a.amount),0) AS remaining_amount
      FROM ${SCHEMA}.remittance r
       LEFT JOIN ${SCHEMA}.allocation a ON a.remittance_id=r.remittance_id
      GROUP BY r.remittance_id,r.period,r.total_amount
     HAVING r.total_amount-COALESCE(SUM(a.amount),0)>0
      ORDER BY r.remittance_id`,
    []
  );
  const activeReferences: string[] = [];
  for (const row of source.rows) {
    const itemReference = String(row['item_reference']);
    const dueAt = dueAtFor(String(row['accounting_period']), policy);
    if (!dueAt) continue;
    activeReferences.push(itemReference);
    const state = stateAt(now, dueAt, policy.approachOffsets, policy.timezone);
    const nextCheck = nextCheckAt(now, dueAt, policy);
    await db.query(`SELECT ${SCHEMA}.save_chase_item_status($1,$2,$3,$4,$5,$6)`, [
      taskId,
      itemReference,
      dueAt.toISOString(),
      state,
      nextCheck?.toISOString() ?? null,
      row['remaining_amount'],
    ]);
  }
  await db.query(`SELECT ${SCHEMA}.resolve_missing_chase_items($1,$2::text[]) AS resolved_count`, [
    taskId,
    activeReferences,
  ]);
  // Chase activity intentionally shares the product-wide task_activity feed.
  await db.query(
    `INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
     VALUES($1,$2,'chase_evaluated','success',jsonb_build_object('item_count',$3::int))`,
    [taskId, actor, activeReferences.length]
  );
  return activeReferences.length;
}

export function setupChaseRoutes(appkit: ChaseAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/reminders/approval-queue', async (req, res) => {
      try {
        const actor = actorOf(req);
        if (!actor) {
          res.status(403).json({ error: 'You do not have access to reminder approvals.' });
          return;
        }
        const result = await appkit.lakebase.asUser(req).query(
          `SELECT batch_id,task_id,task_name,owner_email,evaluated_at,item_count,
                  offset_kinds,due_dates,item_preview
             FROM ${SCHEMA}.get_pending_chase_batches()`
        );
        res.json({ batches: result.rows });
      } catch {
        res.status(500).json({ error: 'The reminder approval queue is unavailable right now. Please try again.' });
      }
    });

    app.post('/api/reminders/batches/:batchId/action', async (req, res) => {
      const parsed = batchActionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Confirm the reminder decision and try again.' });
        return;
      }
      try {
        const actor = actorOf(req);
        if (!actor) {
          res.status(403).json({ error: 'You do not have access to reminder approvals.' });
          return;
        }
        const db = appkit.lakebase.asUser(req);
        // This function applies the same owner-or-DB-trusted-approver filter as the mutation.
        const queue = await db.query(`SELECT * FROM ${SCHEMA}.get_pending_chase_batches()`);
        const selected = queue.rows.find((row) => row['batch_id'] === req.params.batchId);
        if (!selected) {
          res.status(403).json({ error: 'This reminder batch is unavailable or you are not allowed to review it.' });
          return;
        }
        if (!['owner', 'collections_approver'].includes(String(selected['reviewer_role']))) {
          res.status(403).json({ error: 'Only the automation owner or a collections approver can review this batch.' });
          return;
        }
        const functionName = parsed.data.action === 'approve' ? 'approve_chase_batch' : 'archive_chase_batch';
        const result = await db.query(`SELECT * FROM ${SCHEMA}.${functionName}($1::uuid,$2::text)`, [
          req.params.batchId,
          parsed.data.note,
        ]);
        const audit = result.rows[0];
        if (!audit) {
          res.status(409).json({ error: 'This reminder batch was already reviewed. Refresh the queue to continue.' });
          return;
        }
        const count = Number(audit['item_count'] ?? 0);
        res.json({
          message:
            parsed.data.action === 'approve'
              ? `${count} reminder${count === 1 ? '' : 's'} approved for the next internal digest.`
              : `${count} reminder${count === 1 ? '' : 's'} archived. Nothing will be announced.`,
          audit,
        });
      } catch {
        res.status(500).json({ error: 'That reminder decision could not be saved. Nothing was changed.' });
      }
    });

    app.get('/api/tasks/:id/reminders/config', async (req, res) => {
      try {
        const db = appkit.lakebase.asUser(req);
        const access = await requireMember(db, req, res);
        if (!access) return;
        const result = await db.query(
          `SELECT task_id,enabled,cadence,due_offset_days,default_due_at,approach_offsets,
                  post_due_offsets,quiet_hours_start,quiet_hours_end,timezone,updated_by,updated_at
             FROM ${SCHEMA}.get_task_schedule_config($1)`,
          [req.params.id]
        );
        res.json({ config: result.rows[0] ?? null, can_edit: canManage(access.actor, access.role) });
      } catch {
        friendlyFailure(res);
      }
    });

    app.put('/api/tasks/:id/reminders/config', async (req, res) => {
      const parsed = scheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Check the reminder schedule and try again.' });
        return;
      }
      try {
        const db = appkit.lakebase.asUser(req);
        const access = await requireMember(db, req, res);
        if (!access) return;
        if (!canManage(access.actor, access.role)) {
          await logFailure(appkit, req, 'chase_schedule_saved');
          res.status(403).json({ error: 'Only the automation owner or an administrator can edit reminders.' });
          return;
        }
        if (!RECEIVABLE_TASK_TYPES.has(access.taskType)) {
          res.status(400).json({ error: 'Reminders are currently available for receivables automations only.' });
          return;
        }
        const value = parsed.data;
        const result = await db.query(
          `SELECT * FROM ${SCHEMA}.save_task_schedule_config(
             $1,$2,$3,$4,$5,$6::int[],$7::int[],$8::time,$9::time,$10)`,
          [
            req.params.id,
            value.enabled,
            value.cadence,
            value.due_offset_days,
            value.default_due_at,
            [...new Set(value.approach_offsets)].sort((a, b) => b - a),
            [...new Set(value.post_due_offsets)].sort((a, b) => a - b),
            value.quiet_hours_start,
            value.quiet_hours_end,
            value.timezone,
          ]
        );
        res.json(result.rows[0]);
      } catch (error) {
        await logFailure(appkit, req, 'chase_schedule_saved');
        if (isSharedLedgerOwnerConflict(error)) {
          res.status(409).json({
            error: 'Reminders are already enabled for another automation using this shared receivables ledger.',
          });
          return;
        }
        friendlyFailure(res);
      }
    });

    app.post('/api/tasks/:id/reminders/evaluate', async (req, res) => {
      try {
        const db = appkit.lakebase.asUser(req);
        const access = await requireMember(db, req, res);
        if (!access) return;
        if (!canManage(access.actor, access.role)) {
          await logFailure(appkit, req, 'chase_evaluated');
          res.status(403).json({ error: 'Only the automation owner or an administrator can refresh reminders.' });
          return;
        }
        if (!RECEIVABLE_TASK_TYPES.has(access.taskType)) {
          res.status(400).json({ error: 'Reminders are currently available for receivables automations only.' });
          return;
        }
        const binding = await db.query(
          `SELECT EXISTS(
             SELECT 1 FROM ${SCHEMA}.destination_binding b
              WHERE b.task_id=$1 AND b.status='active'
                AND b.dest_schema='genie_spike'
                AND b.dest_table IN ('allocation','remittance')
                AND b.write_scope->'change_types'='["allocation_upsert"]'::jsonb
           ) AS active`,
          [req.params.id]
        );
        if (binding.rows[0]?.['active'] !== true) {
          res.status(400).json({ error: 'This automation needs an active receivables destination before reminders can refresh.' });
          return;
        }
        const itemCount = await evaluate(db, req.params.id, access.actor, new Date());
        res.json({ item_count: itemCount });
      } catch {
        await logFailure(appkit, req, 'chase_evaluated');
        friendlyFailure(res);
      }
    });

    app.get('/api/tasks/:id/reminders/preview', async (req, res) => {
      try {
        const db = appkit.lakebase.asUser(req);
        const access = await requireMember(db, req, res);
        if (!access) return;
        const result = await db.query(
          `SELECT item_reference,due_at,state,outstanding_amount,next_check_at,enabled,timezone
             FROM ${SCHEMA}.get_chase_preview($1)`,
          [req.params.id]
        );
        const approaching = result.rows.filter((row) => row['state'] === 'approaching_due').length;
        const overdue = result.rows.filter((row) => row['state'] === 'overdue').length;
        const summary =
          result.rows.length === 0
            ? 'No reminders would be sent right now.'
            : `${result.rows.length} internal reminder${result.rows.length === 1 ? '' : 's'} would be sent: ${approaching} approaching due and ${overdue} overdue.`;
        res.json({ counts: { total: result.rows.length, approaching, overdue }, summary, items: result.rows });
      } catch {
        friendlyFailure(res);
      }
    });
  });
}
