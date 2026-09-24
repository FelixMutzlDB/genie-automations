import { readFileSync } from 'node:fs';
import { Application, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupConfigRoutes } from './config';

type Handler = (req: Request, res: Response) => void | Promise<void>;

function routeHarness() {
  const handlers = new Map<string, Handler>();
  const query = vi.fn().mockResolvedValue({ rows: [{}] });
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
    put(path: string, handler: Handler) {
      handlers.set(`PUT ${path}`, handler);
    },
  } as Application;
  setupConfigRoutes({
    lakebase: { asUser: () => ({ query }) },
    server: { extend: (register) => register(app) },
  });
  return { handlers, query };
}

function request(actor: string, params: Record<string, string> = {}, body: unknown = {}): Request {
  return {
    params,
    body,
    header: (name: string) => (name === 'x-forwarded-email' ? actor : undefined),
  } as Request;
}

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

afterEach(() => vi.unstubAllEnvs());

describe('config admin route authorization', () => {
  const nonAdminCases: Array<{
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    body?: unknown;
  }> = [
    { method: 'GET', path: '/api/admin/config-destinations' },
    {
      method: 'POST',
      path: '/api/admin/tasks/:id/bindings',
      params: { id: 'task-1' },
      body: { dest_catalog: 'catalog', dest_schema: 'schema', dest_table: 'table' },
    },
    {
      method: 'POST',
      path: '/api/admin/tasks/:id/bindings/:bindingId/approve',
      params: { id: 'task-1', bindingId: 'binding-1' },
    },
    {
      method: 'POST',
      path: '/api/admin/tasks/:id/config/:hash/publish',
      params: { id: 'task-1', hash: 'a'.repeat(64) },
    },
    {
      method: 'POST',
      path: '/api/admin/tasks/:id/config/:hash/retire',
      params: { id: 'task-1', hash: 'a'.repeat(64) },
    },
  ];

  it.each(nonAdminCases)('rejects a non-admin before $method $path reaches the database', async (testCase) => {
    vi.stubEnv('CONFIG_ADMIN_PRINCIPALS', 'admin@example.com');
    const { handlers, query } = routeHarness();
    const { res, state } = response();

    await handlers.get(`${testCase.method} ${testCase.path}`)?.(
      request('user@example.com', testCase.params, testCase.body),
      res
    );

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: 'Administrator access is required.' });
    expect(query).not.toHaveBeenCalled();
  });

  it('allows a configured admin through to the protected mutation boundary', async () => {
    vi.stubEnv('CONFIG_ADMIN_PRINCIPALS', 'admin@example.com');
    vi.stubEnv('CONFIG_DESTINATION_ALLOWLIST', 'catalog.schema.table');
    const { handlers, query } = routeHarness();
    const { res, state } = response();

    await handlers.get('POST /api/admin/tasks/:id/bindings')?.(
      request('ADMIN@example.com', { id: 'task-1' }, {
        dest_catalog: 'catalog',
        dest_schema: 'schema',
        dest_table: 'table',
      }),
      res
    );

    expect(state.status).toBe(201);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('propose_destination_binding'), [
      'task-1',
      'catalog',
      'schema',
      'table',
    ]);
  });
});

describe('config governance database contract', () => {
  const migration = readFileSync(new URL('../../migrations/002_config_governance.sql', import.meta.url), 'utf8');

  it('computes hashes in the database and makes published payload/hash immutable', () => {
    expect(migration).toMatch(/digest\(convert_to\(NEW\.payload::text\s*,?\s*'UTF8'\)\s*,?\s*'sha256'\)/);
    expect(migration).toContain('published config is immutable except retirement');
    for (const protectedColumn of ['payload', 'created_by', 'approved_by', 'created_at', 'published_at']) {
      expect(migration).toContain(`NEW.${protectedColumn} IS DISTINCT FROM OLD.${protectedColumn}`);
    }
  });

  it('enforces maker-checker for binding and config approval', () => {
    expect(migration).toContain('approved_by IS DISTINCT FROM proposed_by');
    expect(migration).toContain('approved_by IS DISTINCT FROM created_by');
  });

  it('atomically rotates an existing active binding before approving its replacement', () => {
    const functionBody = migration.match(/FUNCTION genie_spike\.approve_destination_binding[^]*?\$\$([^]*?)\$\$;/)?.[1];
    expect(functionBody).toBeDefined();
    expect(functionBody).toContain('WHERE task_id=p_task_id FOR UPDATE');
    expect(functionBody).toContain("status='pending'");
    expect(functionBody).toContain('lower(proposed_by)<>lower(session_user)');
    expect(functionBody).toContain('IF pending.binding_id IS NULL THEN RETURN; END IF');

    const retire = functionBody?.indexOf("SET status='retired',retired_at=now()");
    const activate = functionBody?.indexOf("SET status='active',approved_by=session_user,approved_at=now()");
    expect(retire).toBeGreaterThan(0);
    expect(activate).toBeGreaterThan(retire ?? Number.MAX_SAFE_INTEGER);
    expect(functionBody).toContain("WHERE task_id=p_task_id AND status='active'");
    expect(functionBody).toContain("binding_id=p_binding_id AND status='pending'");
    expect(migration).toContain("ON genie_spike.destination_binding(task_id) WHERE status='active'");
  });

  it('is additive and leaves the guarded mutation procedures untouched', () => {
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(migration).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+genie_spike\.(?:stage_change|approve_change|commit_change)/i
    );
  });

  it('seeds both existing tasks and is policy-idempotent', () => {
    expect(migration).toContain("'receivables-eu','allocation'");
    expect(migration).toContain("'vendor-bank-eu','vendor_bank_detail'");
    expect(migration).toContain('{"change_types":["vendor_bank_update"]}');
    expect(migration.match(/DROP POLICY IF EXISTS/g)).toHaveLength(6);
    expect(migration.match(/CREATE POLICY/g)).toHaveLength(6);
    expect(migration).toContain('ON CONFLICT DO NOTHING');
  });

  it('uses security-definer functions as the OBO governance write boundary', () => {
    const routes = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
    for (const functionName of [
      'save_config_draft',
      'submit_config_draft',
      'propose_destination_binding',
      'approve_destination_binding',
      'publish_config_version',
      'retire_config_version',
    ]) {
      expect(migration).toMatch(new RegExp(`FUNCTION genie_spike\\.${functionName}[^]*SECURITY DEFINER`));
      expect(routes).toContain(`\${SCHEMA}.${functionName}`);
    }
    expect(routes).not.toMatch(
      /(?:INSERT INTO|UPDATE) \\?\$\{SCHEMA\}\\?\.(?:destination_binding|config_version|task_config_state)/
    );
  });

  it('requires admin principals and destination allowlists at deploy time', () => {
    const appYaml = readFileSync(new URL('../../app.yaml', import.meta.url), 'utf8');
    const bundle = readFileSync(new URL('../../databricks.yml', import.meta.url), 'utf8');
    expect(appYaml).toContain('name: LAKEBASE_ENDPOINT\n    valueFrom: postgres');
    expect(appYaml).toContain('name: DATABRICKS_VOLUME_FILES\n    valueFrom: files');
    expect(appYaml).toContain('name: DATABRICKS_JOB_ID\n    valueFrom: job');
    expect(appYaml).toContain('name: CONFIG_ADMIN_PRINCIPALS\n    valueFrom: config-admin-principals');
    expect(appYaml).toContain('name: CONFIG_DESTINATION_ALLOWLIST\n    valueFrom: config-destination-allowlist');
    expect(bundle).toContain('name: config-admin-principals\n          secret:');
    expect(bundle).toContain('name: config-destination-allowlist\n          secret:');
    expect(bundle).toContain('scope: ${var.config_secret_scope}');
    expect(bundle).toContain('key: ${var.config_admin_principals_secret_key}');
    expect(bundle).toContain('key: ${var.config_destination_allowlist_secret_key}');
    expect(bundle).toMatch(/secret:\n\s+scope: \$\{var\.config_secret_scope\}\n\s+key: [^\n]+\n\s+permission: READ/);
    expect(bundle).not.toMatch(/\n\s+config:\n\s+env:/);
    expect(bundle).not.toContain('felix.mutzl@databricks.com');
  });
});
