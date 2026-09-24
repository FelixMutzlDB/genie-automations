import { Request } from 'express';
import { bindingDigest } from './canonical';

const SCHEMA = 'genie_spike';

interface QueryResult {
  rows: Record<string, unknown>[];
}
export interface ResolverDb {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}
interface ResolverAppKit {
  lakebase: { asUser(req: Request): ResolverDb };
}

export type TaskOperation = 'allocation_upsert' | 'vendor_bank_update';
export interface TaskExecutionSpec {
  taskId: string;
  taskType: string;
  configVersionHash: string;
  settings: Record<string, unknown>;
  destination: { catalog: string; schema: string; table: string; fullyQualifiedName: string };
  writeScope: Record<string, unknown>;
  identityRef: 'obo_user';
  bindingId: string;
}

export class ConfigResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

let configuredAppKit: ResolverAppKit | undefined;
export function configureTaskConfigResolver(appkit: ResolverAppKit): void {
  configuredAppKit = appkit;
}

function actorOf(req: Request): string {
  const actor = req.header('x-forwarded-email')?.trim();
  if (!actor) throw new ConfigResolutionError('missing_identity', 'Authenticated identity is required.', 401);
  return actor.toLowerCase();
}

function destinationAllowlist(): Set<string> {
  return new Set(
    (process.env['CONFIG_DESTINATION_ALLOWLIST'] ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function resolveTaskConfig(
  req: Request,
  taskId: string,
  configVersionHash: string,
  operation: TaskOperation,
  requireActive = true
): Promise<TaskExecutionSpec> {
  if (!configuredAppKit) throw new Error('Task config resolver is not configured');
  const actor = actorOf(req);
  const result = await configuredAppKit.lakebase.asUser(req).query(
    `SELECT t.task_id, t.task_type, cv.version_hash, cv.payload, cv.status AS config_status,
            encode(digest(convert_to(cv.payload::text, 'UTF8'), 'sha256'), 'hex') AS computed_hash,
            tcs.active_version_hash, db.binding_id, db.dest_catalog, db.dest_schema,
            db.dest_table, db.write_scope, db.identity_ref, db.status AS binding_status
       FROM ${SCHEMA}.task t
       JOIN ${SCHEMA}.task_member tm ON tm.task_id=t.task_id AND lower(tm.user_id)=lower($2)
       JOIN ${SCHEMA}.config_version cv ON cv.task_id=t.task_id AND cv.version_hash=$3
       LEFT JOIN ${SCHEMA}.task_config_state tcs ON tcs.task_id=t.task_id
       JOIN ${SCHEMA}.destination_binding db ON db.task_id=t.task_id AND db.status='active'
      WHERE t.task_id=$1 AND t.status='active'`,
    [taskId, actor, configVersionHash]
  );
  const row = result.rows[0];
  if (!row) throw new ConfigResolutionError('not_authorized', 'Task configuration is unavailable.', 403);
  if (row['config_status'] !== 'published')
    throw new ConfigResolutionError('config_not_published', 'Configuration is not published.');
  if (requireActive && row['active_version_hash'] !== configVersionHash)
    throw new ConfigResolutionError('config_not_active', 'Configuration is not active.');
  if (row['binding_status'] !== 'active')
    throw new ConfigResolutionError('binding_not_active', 'Destination binding is not active.');
  const payload = row['payload'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new ConfigResolutionError('invalid_config', 'Configuration payload is invalid.');
  if (row['computed_hash'] !== configVersionHash)
    throw new ConfigResolutionError('hash_mismatch', 'Configuration integrity check failed.');
  const writeScope = row['write_scope'];
  if (!writeScope || typeof writeScope !== 'object' || Array.isArray(writeScope))
    throw new ConfigResolutionError('invalid_scope', 'Write scope is invalid.');
  const taskType = typeof row['task_type'] === 'string' ? row['task_type'] : '';
  const changeTypes = (writeScope as Record<string, unknown>)['change_types'];
  if (
    (taskType !== 'receivables' && taskType !== 'allocation_upsert' && taskType !== 'reconciliation') ||
    !Array.isArray(changeTypes) ||
    !changeTypes.includes(operation)
  ) {
    throw new ConfigResolutionError('wrong_scope', 'Operation is outside the approved write scope.', 403);
  }
  const destCatalog = typeof row['dest_catalog'] === 'string' ? row['dest_catalog'] : '';
  const destSchema = typeof row['dest_schema'] === 'string' ? row['dest_schema'] : '';
  const destTable = typeof row['dest_table'] === 'string' ? row['dest_table'] : '';
  const destination = `${destCatalog}.${destSchema}.${destTable}`;
  if (!destinationAllowlist().has(destination.toLowerCase()))
    throw new ConfigResolutionError('destination_not_allowed', 'Destination is not deployment-approved.', 403);
  if (row['identity_ref'] !== 'obo_user')
    throw new ConfigResolutionError('identity_not_allowed', 'Interactive operations require OBO identity.', 403);
  const digest = bindingDigest({
    task_id: taskId,
    dest_catalog: destCatalog,
    dest_schema: destSchema,
    dest_table: destTable,
    write_scope: writeScope,
    identity_ref: typeof row['identity_ref'] === 'string' ? row['identity_ref'] : '',
  });
  if ((payload as Record<string, unknown>)['binding_digest'] !== digest)
    throw new ConfigResolutionError('binding_mismatch', 'Configuration is not bound to the active destination.');
  const settings = (payload as Record<string, unknown>)['settings'];
  return {
    taskId,
    taskType,
    configVersionHash,
    settings:
      settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {},
    destination: { catalog: destCatalog, schema: destSchema, table: destTable, fullyQualifiedName: destination },
    writeScope: writeScope as Record<string, unknown>,
    identityRef: 'obo_user',
    bindingId: String(row['binding_id']),
  };
}

export async function activeConfigHash(req: Request, taskId: string): Promise<string> {
  if (!configuredAppKit) throw new Error('Task config resolver is not configured');
  const actor = actorOf(req);
  const result = await configuredAppKit.lakebase.asUser(req).query(
    `SELECT tcs.active_version_hash FROM ${SCHEMA}.task_config_state tcs
      JOIN ${SCHEMA}.task_member tm ON tm.task_id=tcs.task_id AND lower(tm.user_id)=lower($2)
      WHERE tcs.task_id=$1`,
    [taskId, actor]
  );
  const hash = result.rows[0]?.['active_version_hash'];
  if (typeof hash !== 'string')
    throw new ConfigResolutionError('unbound', 'This automation is awaiting admin configuration.');
  return hash;
}
