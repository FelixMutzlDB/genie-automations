import { Application, Request, Response } from 'express';
import { z } from 'zod';
import { bindingDigest, configHash } from '../config/canonical';

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
function payload(settings: z.infer<typeof settingsSchema>, digest: string): Record<string, unknown> {
  return {
    binding_digest: digest,
    platform_minimums: {
      money_column_presence: true,
      money_parse_validity: true,
      cross_foot_totals: true,
      non_negative_allocations: true,
      over_allocation_ceiling: 1,
      structural_confidence_floor: 0.8,
    },
    settings,
  };
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
      const db = appkit.lakebase.asUser(req);
      const binding = await db.query(
        `SELECT db.task_id, db.dest_catalog, db.dest_schema, db.dest_table, db.write_scope, db.identity_ref
           FROM ${SCHEMA}.destination_binding db JOIN ${SCHEMA}.task_member tm ON tm.task_id=db.task_id
          WHERE db.task_id=$1 AND lower(tm.user_id)=lower($2) AND tm.role='owner'
            AND db.status IN ('pending','active') ORDER BY db.proposed_at DESC LIMIT 1`,
        [req.params.id, actor]
      );
      const row = binding.rows[0];
      if (!row) {
        res.status(409).json({ error: 'An admin binding is required before settings can be submitted.' });
        return;
      }
      const digest = bindingDigest({
        task_id: String(row['task_id']),
        dest_catalog: String(row['dest_catalog']),
        dest_schema: String(row['dest_schema']),
        dest_table: String(row['dest_table']),
        write_scope: row['write_scope'],
        identity_ref: String(row['identity_ref']),
      });
      const body = payload(parsed.data, digest);
      const result = await db.query(
        `INSERT INTO ${SCHEMA}.config_version(task_id,version_hash,payload,status,created_by)
         VALUES ($1,$2,$3::jsonb,'draft',$4)
         ON CONFLICT (task_id,version_hash) DO UPDATE SET payload=EXCLUDED.payload
           WHERE ${SCHEMA}.config_version.status='draft' AND ${SCHEMA}.config_version.created_by=$4
         RETURNING task_id,version_hash,status`,
        [req.params.id, configHash(body), JSON.stringify(body), actor]
      );
      res.json(result.rows[0]);
    });

    app.post('/api/tasks/:id/config/submit', async (req, res) => {
      const actor = actorOf(req);
      const result = await appkit.lakebase.asUser(req).query(
        `WITH owned AS (SELECT 1 FROM ${SCHEMA}.task_member WHERE task_id=$1 AND lower(user_id)=lower($2) AND role='owner'),
         draft AS (SELECT version_hash FROM ${SCHEMA}.config_version WHERE task_id=$1 AND created_by=$2 AND status='draft' ORDER BY created_at DESC LIMIT 1),
         activity AS (INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
           SELECT $1,$2,'config_submitted','success',jsonb_build_object('version_hash',draft.version_hash) FROM draft,owned RETURNING 1)
         SELECT version_hash FROM draft WHERE EXISTS (SELECT 1 FROM activity)`,
        [req.params.id, actor]
      );
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
      const result = await appkit.lakebase.asUser(req).query(
        `WITH task_ok AS (SELECT task_id FROM ${SCHEMA}.task WHERE task_id=$1 AND task_type IN ('receivables','allocation_upsert','reconciliation')),
         inserted AS (INSERT INTO ${SCHEMA}.destination_binding(task_id,dest_catalog,dest_schema,dest_table,write_scope,identity_ref,status,proposed_by)
           SELECT task_id,$2,$3,$4,'{"change_types":["allocation_upsert"]}'::jsonb,'obo_user','pending',$5 FROM task_ok RETURNING *),
         activity AS (INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
           SELECT task_id,$5,'binding_proposed','success',jsonb_build_object('binding_id',binding_id) FROM inserted)
         SELECT * FROM inserted`,
        [req.params.id, parsed.data.dest_catalog, parsed.data.dest_schema, parsed.data.dest_table, actor]
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: 'Only receivables tasks can be bound in this release.' });
        return;
      }
      res.status(201).json(result.rows[0]);
    });

    app.post('/api/admin/tasks/:id/bindings/:bindingId/approve', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const result = await appkit.lakebase.asUser(req).query(
        `WITH approved AS (UPDATE ${SCHEMA}.destination_binding SET status='active',approved_by=$3,approved_at=now()
           WHERE task_id=$1 AND binding_id=$2 AND status='pending' AND lower(proposed_by)<>lower($3) RETURNING *),
         activity AS (INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
           SELECT task_id,$3,'binding_approved','success',jsonb_build_object('binding_id',binding_id) FROM approved)
         SELECT * FROM approved`,
        [req.params.id, req.params.bindingId, actor]
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: 'A different admin must approve this binding.' });
        return;
      }
      res.json(result.rows[0]);
    });

    app.post('/api/admin/tasks/:id/config/:hash/publish', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const db = appkit.lakebase.asUser(req);
      const candidate = await db.query(
        `SELECT cv.payload,db.task_id,db.dest_catalog,db.dest_schema,db.dest_table,db.write_scope,db.identity_ref
           FROM ${SCHEMA}.config_version cv JOIN ${SCHEMA}.destination_binding db ON db.task_id=cv.task_id AND db.status='active'
          WHERE cv.task_id=$1 AND cv.version_hash=$2 AND cv.status='draft'`,
        [req.params.id, req.params.hash]
      );
      const bound = candidate.rows[0];
      if (!bound || !bound['payload'] || typeof bound['payload'] !== 'object' || Array.isArray(bound['payload'])) {
        res.status(409).json({ error: 'A draft with an active binding is required.' });
        return;
      }
      const expectedDigest = bindingDigest({
        task_id: String(bound['task_id']),
        dest_catalog: String(bound['dest_catalog']),
        dest_schema: String(bound['dest_schema']),
        dest_table: String(bound['dest_table']),
        write_scope: bound['write_scope'],
        identity_ref: String(bound['identity_ref']),
      });
      if ((bound['payload'] as Record<string, unknown>)['binding_digest'] !== expectedDigest) {
        res.status(409).json({ error: 'The draft does not match the active destination binding.' });
        return;
      }
      const result = await db.query(
        `WITH published AS (UPDATE ${SCHEMA}.config_version cv SET status='published',approved_by=$3,published_at=now()
           WHERE cv.task_id=$1 AND cv.version_hash=$2 AND cv.status='draft' AND lower(cv.created_by)<>lower($3)
             AND EXISTS (SELECT 1 FROM ${SCHEMA}.destination_binding db WHERE db.task_id=cv.task_id AND db.status='active') RETURNING *),
         state AS (INSERT INTO ${SCHEMA}.task_config_state(task_id,active_version_hash,updated_at)
           SELECT task_id,version_hash,now() FROM published ON CONFLICT(task_id) DO UPDATE SET active_version_hash=EXCLUDED.active_version_hash,updated_at=now()),
         activity AS (INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
           SELECT task_id,$3,'config_published','success',jsonb_build_object('version_hash',version_hash) FROM published)
         SELECT task_id,version_hash,status FROM published WHERE EXISTS (SELECT 1 FROM state)`,
        [req.params.id, req.params.hash, actor]
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: 'A different admin/owner must publish a draft with an active binding.' });
        return;
      }
      res.json(result.rows[0]);
    });

    app.post('/api/admin/tasks/:id/config/:hash/retire', async (req, res) => {
      const actor = requireAdmin(req, res);
      if (!actor) return;
      const result = await appkit.lakebase.asUser(req).query(
        `WITH retired AS (UPDATE ${SCHEMA}.config_version SET status='retired',retired_at=now()
           WHERE task_id=$1 AND version_hash=$2 AND status='published' RETURNING *),
         state AS (UPDATE ${SCHEMA}.task_config_state SET active_version_hash=NULL,updated_at=now()
           WHERE task_id=$1 AND active_version_hash=$2),
         activity AS (INSERT INTO ${SCHEMA}.task_activity(task_id,user_id,action,status,detail)
           SELECT task_id,$3,'config_retired','success',jsonb_build_object('version_hash',version_hash) FROM retired)
         SELECT task_id,version_hash,status FROM retired`,
        [req.params.id, req.params.hash, actor]
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: 'Published configuration not found.' });
        return;
      }
      res.json(result.rows[0]);
    });
  });
}
