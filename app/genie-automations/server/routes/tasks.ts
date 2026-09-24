import { randomUUID } from 'node:crypto';
import { Application, Request, Response } from 'express';

const SCHEMA = 'genie_spike';

interface QueryResult {
  rows: Record<string, unknown>[];
}

interface UserDb {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

interface AppKitOBO {
  lakebase: { asUser(req: Request): UserDb };
  server: { extend(fn: (app: Application) => void): void };
}

interface CreateTaskBody {
  name?: unknown;
  task_type?: unknown;
}

function actorOf(req: Request): string {
  return req.header('x-forwarded-email') ?? 'unknown';
}

function requestIdOf(req: Request): string {
  return req.header('x-request-id') ?? req.header('x-databricks-request-id') ?? 'unavailable';
}

function sqlstateOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err) || typeof err.code !== 'string') return undefined;
  return /^[0-9A-Z]{5}$/.test(err.code) ? err.code : undefined;
}

function taskIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${slug || 'task'}-${randomUUID().slice(0, 8)}`;
}

export function setupTaskRoutes(appkit: AppKitOBO): void {
  appkit.server.extend((app) => {
    app.get('/api/tasks', async (req: Request, res: Response) => {
      const userId = actorOf(req);
      try {
        const result = await appkit.lakebase.asUser(req).query(
          `SELECT t.task_id, t.name, t.task_type, t.org_id,
                  tm.role,
                  CASE
                    WHEN governance.has_active AND cv.status = 'published' THEN 'active'
                    WHEN governance.has_pending THEN 'awaiting_approval'
                    ELSE 'unbound'
                  END AS governance_status,
                  COUNT(all_members.user_id)::int AS member_count
             FROM ${SCHEMA}.task t
             LEFT JOIN ${SCHEMA}.task_member tm
               ON tm.task_id = t.task_id AND tm.user_id = $1
             LEFT JOIN ${SCHEMA}.task_member all_members ON all_members.task_id = t.task_id
             LEFT JOIN LATERAL (
               SELECT bool_or(db.status='active') AS has_active,
                      bool_or(db.status='pending') AS has_pending
                 FROM ${SCHEMA}.destination_binding db WHERE db.task_id=t.task_id
             ) governance ON true
             LEFT JOIN ${SCHEMA}.task_config_state tcs ON tcs.task_id=t.task_id
             LEFT JOIN ${SCHEMA}.config_version cv ON cv.task_id=tcs.task_id AND cv.version_hash=tcs.active_version_hash
            WHERE t.status = 'active' AND t.org_id = 'org-demo'
            GROUP BY t.task_id, t.name, t.task_type, t.org_id, tm.role,
                     governance.has_active, governance.has_pending, cv.status
            ORDER BY t.created_at DESC`,
          [userId]
        );
        res.json(result.rows);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post('/api/tasks', async (req: Request, res: Response) => {
      const body = req.body as CreateTaskBody;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const taskType = typeof body.task_type === 'string' ? body.task_type.trim() : '';
      if (!name || !taskType) {
        res.status(400).json({ error: 'name and task_type are required' });
        return;
      }
      const submittedKeys = Object.keys(body as Record<string, unknown>);
      const forbidden = submittedKeys.filter((key) => !['name', 'task_type'].includes(key));
      if (forbidden.length > 0) {
        res.status(400).json({ error: `unsupported task fields: ${forbidden.sort().join(', ')}` });
        return;
      }

      const userId = actorOf(req);
      const taskId = taskIdFor(name);
      try {
        const result = await appkit.lakebase.asUser(req).query(
          `WITH selected_org AS (
             SELECT org_id FROM ${SCHEMA}.organization WHERE org_id = 'org-demo'
           ), new_task AS (
             INSERT INTO ${SCHEMA}.task(task_id, org_id, name, task_type, owner_id)
             SELECT $2, org_id, $3, $4, $1 FROM selected_org
             RETURNING *
           ), new_member AS (
             INSERT INTO ${SCHEMA}.task_member(task_id, user_id, role, source)
             SELECT task_id, $1, 'owner', 'prefilled' FROM new_task
             RETURNING task_id
           ), activity AS (
             INSERT INTO ${SCHEMA}.task_activity(task_id, user_id, action, status, detail)
             SELECT task_id, $1, 'task_created', 'success',
                    jsonb_build_object('task_type', task_type)
               FROM new_task
           )
           SELECT nt.*, 'owner'::text AS role, 1::int AS member_count,
                  'unbound'::text AS governance_status
             FROM new_task nt
             JOIN new_member nm USING (task_id)`,
          [userId, taskId, name, taskType]
        );
        if (!result.rows[0]) {
          res.status(403).json({ error: 'No organization is associated with the current user' });
          return;
        }
        res.status(201).json(result.rows[0]);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post('/api/tasks/:id/join', async (req: Request, res: Response) => {
      const userId = actorOf(req);
      try {
        const result = await appkit.lakebase.asUser(req).query(
          `WITH eligible AS (
             SELECT t.task_id
               FROM ${SCHEMA}.task t
              WHERE t.task_id = $2 AND t.status = 'active' AND t.org_id = 'org-demo'
           ), joined AS (
             INSERT INTO ${SCHEMA}.task_member(task_id, user_id, role, source)
             SELECT task_id, $1, 'member', 'joined' FROM eligible
             ON CONFLICT DO NOTHING
             RETURNING task_id
           ), activity AS (
             INSERT INTO ${SCHEMA}.task_activity(task_id, user_id, action, status)
             SELECT task_id, $1, 'joined', 'success' FROM joined
           )
           SELECT tm.task_id, tm.role
             FROM ${SCHEMA}.task_member tm
             JOIN eligible e ON e.task_id = tm.task_id
            WHERE tm.user_id = $1`,
          [userId, req.params.id]
        );
        if (!result.rows[0]) {
          res.status(404).json({ error: 'Task not found in the current organization' });
          return;
        }
        res.json({ ok: true, role: result.rows[0]['role'] });
      } catch (err) {
        const requestId = requestIdOf(req);
        const sqlstate = sqlstateOf(err);
        console.error('Task join failed', {
          request_id: requestId,
          actor: userId,
          task_id: req.params.id,
          ...(sqlstate ? { sqlstate } : {}),
        });
        res.status(500).json({
          ok: false,
          code: 'JOIN_FAILED',
          error: 'Unable to join this automation right now.',
          request_id: requestId,
        });
      }
    });

    app.get('/api/tasks/:id/activity', async (req: Request, res: Response) => {
      const userId = actorOf(req);
      try {
        const result = await appkit.lakebase.asUser(req).query(
          `WITH user_orgs AS (
             SELECT DISTINCT t.org_id
               FROM ${SCHEMA}.task t
               LEFT JOIN ${SCHEMA}.task_member tm ON tm.task_id = t.task_id
              WHERE tm.user_id = $1 OR t.owner_id = $1
           )
           SELECT a.user_id, a.action, a.status, a.detail, a.proposal_id, a.occurred_at
             FROM ${SCHEMA}.task_activity a
             JOIN ${SCHEMA}.task t ON t.task_id = a.task_id
             JOIN user_orgs uo ON uo.org_id = t.org_id
            WHERE a.task_id = $2
            ORDER BY a.occurred_at DESC
            LIMIT 50`,
          [userId, req.params.id]
        );
        res.json(result.rows);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  });
}
