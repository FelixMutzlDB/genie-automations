import { Application, Request, Response } from 'express';
import { z } from 'zod';

const SCHEMA = 'genie_spike';
interface QueryResult {
  rows: Record<string, unknown>[];
}
interface UserDb {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}
interface ConfigAppKit {
  lakebase: { asUser(req: Request): UserDb };
  server: { extend(fn: (app: Application) => void): void };
}

const settingsSchema = z
  .object({
    ingest_enabled: z.boolean(),
    validation_thresholds: z
      .object({
        over_allocation_ceiling: z.number().positive().max(1),
        structural_confidence_floor: z.number().min(0.8).max(1),
      })
      .strict(),
    header_aliases: z.record(z.string(), z.array(z.string().min(1).max(100)).max(20)).default({}),
  })
  .strict();
const bindingSchema = z
  .object({
    dest_catalog: z.string().min(1),
    dest_schema: z.string().min(1),
    dest_table: z.string().min(1),
  })
  .strict();

function actorOf(req: Request): string {
  return (req.header('x-forwarded-email') ?? '').trim().toLowerCase();
}
function adminPrincipals(): Set<string> {
  return new Set(
    (process.env['CONFIG_ADMIN_PRINCIPALS'] ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}
function destinationAllowlist(): Set<string> {
  return new Set(
    (process.env['CONFIG_DESTINATION_ALLOWLIST'] ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}
function requireAdmin(req: Request, res: Response): string | undefined {
  const actor = actorOf(req);
  if (!actor || !adminPrincipals().has(actor)) {
    res.status(403).json({ error: 'Administrator access is required.' });
    return;
  }
  return actor;
}
export function setupConfigRoutes(appkit: ConfigAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/tasks/:id/config', async (req, res) => {
      const actor = actorOf(req);
      const result = await appkit.lakebase.asUser(req).query(
        `SELECT cv.version_hash, cv.payload->'settings' AS settings, cv.status,
                db.dest_catalog, db.dest_schema, db.dest_table, db.status AS binding_status,
                (tcs.active_version_hash=cv.version_hash) AS active
           FROM ${SCHEMA}.task t
           JOIN ${SCHEMA}.task_member tm ON tm.task_id=t.task_id AND lower(tm.user_id)=lower($2)
           LEFT JOIN ${SCHEMA}.destination_binding db ON db.task_id=t.task_id AND db.status IN ('pending','active')
           LEFT JOIN ${SCHEMA}.config_version cv ON cv.task_id=t.task_id AND cv.status IN ('draft','published')
           LEFT JOIN ${SCHEMA}.task_config_state tcs ON tcs.task_id=t.task_id
          WHERE t.task_id=$1 ORDER BY cv.created_at DESC NULLS LAST LIMIT 1`,
        [req.params.id, actor]
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Automation not found.' });
        return;
      }
      res.json(result.rows[0]);
    });

    app.put('/api/tasks/:id/config/draft', async (req, res) => {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid owner settings.', issues: parsed.error.issues });
        return;
      }
      const actor = actorOf(req);
      if (!actor) {
        res.status(401).json({ error: 'Authenticated identity is required.' });
        return;
      }
      const db = appkit.lakebase.asUser(req);
      const result = await db.query(
        `SELECT task_id,version_hash,status FROM ${SCHEMA}.save_config_draft($1,$2::jsonb)`,
        [req.params.id, JSON.stringify(parsed.data)]
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: 'An identical owner draft already exists.' });
        return;
      }
      res.json(result.rows[0]);
    });

    app.post('/api/tasks/:id/config/submit', async (req, res) => {
      const actor = actorOf(req);
      if (!actor) {
        res.status(401).json({ error: 'Authenticated identity is required.' });
        return;
      }
      const result = await appkit.lakebase
        .asUser(req)
        .query(`SELECT * FROM ${SCHEMA}.submit_config_draft($1)`, [req.params.id]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'No owner draft is available.' });
        return;
      }
      res.status(202).json(result.rows[0]);
    });

    app.get('/api/admin/config-requests', async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const result = await appkit.lakebase.asUser(req).query(
        `SELECT t.task_id,t.name,t.task_type,db.binding_id,db.status AS binding_status,
                cv.version_hash,cv.status AS config_status,cv.created_by
           FROM ${SCHEMA}.task t LEFT JOIN ${SCHEMA}.destination_binding db ON db.task_id=t.task_id AND db.status='pending'
           LEFT JOIN ${SCHEMA}.config_version cv ON cv.task_id=t.task_id AND cv.status='draft'
          WHERE db.binding_id IS NOT NULL OR cv.version_hash IS NOT NULL ORDER BY t.created_at`
      );
      res.json(result.rows);
    });

    app.post('/api/admin/tasks/:id/bindings', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const parsed = bindingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid destination.' });
        return;
      }
      const destination =
        `${parsed.data.dest_catalog}.${parsed.data.dest_schema}.${parsed.data.dest_table}`.toLowerCase();
      if (!destinationAllowlist().has(destination)) {
        res.status(403).json({ error: 'Destination is not deployment-approved.' });
        return;
      }
      const result = await appkit.lakebase
        .asUser(req)
        .query(`SELECT * FROM ${SCHEMA}.propose_destination_binding($1,$2,$3,$4)`, [
          req.params.id,
          parsed.data.dest_catalog,
          parsed.data.dest_schema,
          parsed.data.dest_table,
        ]);
      if (!result.rows[0]) {
        res.status(409).json({ error: 'This task cannot be bound.' });
        return;
      }
      res.status(201).json(result.rows[0]);
    });

    app.post('/api/admin/tasks/:id/bindings/:bindingId/approve', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const result = await appkit.lakebase
        .asUser(req)
        .query(`SELECT * FROM ${SCHEMA}.approve_destination_binding($1,$2::uuid)`, [
          req.params.id,
          req.params.bindingId,
        ]);
      if (!result.rows[0]) {
        res.status(409).json({ error: 'A different admin must approve this binding.' });
        return;
      }
      res.json(result.rows[0]);
    });

    app.post('/api/admin/tasks/:id/config/:hash/publish', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const result = await appkit.lakebase
        .asUser(req)
        .query(`SELECT task_id,version_hash,status FROM ${SCHEMA}.publish_config_version($1,$2::char(64))`, [
          req.params.id,
          req.params.hash,
        ]);
      if (!result.rows[0]) {
        res.status(409).json({ error: 'A different admin/owner must publish a draft with an active binding.' });
        return;
      }
      res.json(result.rows[0]);
    });

    app.post('/api/admin/tasks/:id/config/:hash/retire', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const result = await appkit.lakebase
        .asUser(req)
        .query(`SELECT task_id,version_hash,status FROM ${SCHEMA}.retire_config_version($1,$2::char(64))`, [
          req.params.id,
          req.params.hash,
        ]);
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Published configuration not found.' });
        return;
      }
      res.json(result.rows[0]);
    });
  });
}
