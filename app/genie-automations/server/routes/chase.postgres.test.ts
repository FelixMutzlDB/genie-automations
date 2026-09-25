import { readFileSync } from 'node:fs';
import { Client, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env['CHASE_TEST_DATABASE_URL'];
// The disposable test principal must be able to CREATE ROLE and SET SESSION AUTHORIZATION.
const describePostgres = databaseUrl ? describe.sequential : describe.skip;
const suffix = process.pid.toString(36);
const roles = {
  owner: `chase_it_${suffix}_owner`,
  member: `chase_it_${suffix}_member`,
  outsider: `chase_it_${suffix}_outsider`,
  admin: `chase_it_${suffix}_admin`,
  obo: `chase_it_${suffix}_obo`,
  scheduler: `chase_it_${suffix}_scheduler`,
  publisher: `chase_it_${suffix}_publisher`,
};

function identifier(value: string): string {
  return `"${value.split('"').join('""')}"`;
}

describePostgres('chase SECURITY DEFINER authorization (Postgres integration)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');

    const existing = await client.query<{ schema_name: string | null }>(
      `SELECT to_regnamespace('genie_spike')::text AS schema_name`
    );
    if (existing.rows[0]?.schema_name) {
      throw new Error('CHASE_TEST_DATABASE_URL must point to a disposable database without a genie_spike schema.');
    }

    for (const role of Object.values(roles)) await client.query(`CREATE ROLE ${identifier(role)}`);
    await client.query(
      `GRANT ${identifier(roles.obo)} TO ${identifier(roles.owner)}, ${identifier(roles.member)}, ${identifier(roles.outsider)}, ${identifier(roles.admin)}`
    );
    await client.query(`CREATE SCHEMA genie_spike`);
    await client.query(`
      CREATE TABLE genie_spike.task(
        task_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE genie_spike.task_member(
        task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY(task_id,user_id)
      );
      CREATE TABLE genie_spike.task_activity(
        task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
        user_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        detail JSONB
      );
      CREATE TABLE genie_spike.destination_allowlist(
        dest_catalog TEXT NOT NULL,
        dest_schema TEXT NOT NULL,
        dest_table TEXT NOT NULL,
        PRIMARY KEY(dest_catalog,dest_schema,dest_table)
      );
      CREATE TABLE genie_spike.destination_binding(
        binding_id UUID PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES genie_spike.task(task_id),
        dest_catalog TEXT NOT NULL,
        dest_schema TEXT NOT NULL,
        dest_table TEXT NOT NULL,
        write_scope JSONB NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE genie_spike.remittance(
        remittance_id TEXT PRIMARY KEY,
        subsidiary_id TEXT NOT NULL,
        period TEXT NOT NULL,
        total_amount NUMERIC(18,2) NOT NULL,
        entity_version INTEGER NOT NULL
      );
      CREATE TABLE genie_spike.allocation(
        allocation_id TEXT PRIMARY KEY,
        remittance_id TEXT NOT NULL REFERENCES genie_spike.remittance(remittance_id),
        amount NUMERIC(18,2) NOT NULL
      );
      INSERT INTO genie_spike.task(task_id,name,owner_id,task_type,status) VALUES
        ('task-a','Task A','${roles.owner}','reconciliation','active'),
        ('task-b','Task B','${roles.outsider}','receivables','active');
      INSERT INTO genie_spike.task_member(task_id,user_id,role) VALUES
        ('task-a','${roles.owner}','owner'),
        ('task-a','${roles.member}','member'),
        ('task-b','${roles.outsider}','owner');
      INSERT INTO genie_spike.destination_binding(
        binding_id,task_id,dest_catalog,dest_schema,dest_table,write_scope,status) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','task-a','test_catalog','genie_spike','allocation',
          '{"change_types":["allocation_upsert"]}','active'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','task-b','test_catalog','genie_spike','allocation',
          '{"change_types":["allocation_upsert"]}','active');
      INSERT INTO genie_spike.remittance(remittance_id,subsidiary_id,period,total_amount,entity_version) VALUES
        ('REM-SHARED-1','EU','2026-09',100.00,1),
        ('REM-SHARED-2','EU','2026-09',50.00,1);
      INSERT INTO genie_spike.allocation(allocation_id,remittance_id,amount) VALUES
        ('ALLOC-1','REM-SHARED-1',25.00);
    `);

    const migration = readFileSync(new URL('../../migrations/003_chase_reminders.sql', import.meta.url), 'utf8')
      .split(':"admin_role"')
      .join(identifier(roles.admin))
      .split(':"obo_role"')
      .join(identifier(roles.obo));
    await client.query(migration);
    // Migration 002 grants these in deployed environments; reproduce that prerequisite here.
    await client.query(
      `GRANT USAGE ON SCHEMA genie_spike TO ${identifier(roles.obo)}, ${identifier(roles.admin)}, ${identifier(roles.scheduler)}`
    );
    const schedulerMigration = readFileSync(
      new URL('../../migrations/004_chase_scheduler.sql', import.meta.url),
      'utf8'
    )
      .split(':"admin_role"')
      .join(identifier(roles.admin))
      .split(':"scheduler_role"')
      .join(identifier(roles.scheduler));
    await client.query(schedulerMigration);
    const transportMigration = readFileSync(
      new URL('../../migrations/005_chase_transport.sql', import.meta.url),
      'utf8'
    )
      .split(':"admin_role"')
      .join(identifier(roles.admin))
      .split(':"obo_role"')
      .join(identifier(roles.obo))
      .split(':"scheduler_role"')
      .join(identifier(roles.scheduler))
      .split(':"publisher_role"')
      .join(identifier(roles.publisher));
    await client.query(transportMigration);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('RESET SESSION AUTHORIZATION').catch(() => undefined);
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  });

  async function asPrincipal<T>(role: string, operation: () => Promise<T>): Promise<T> {
    await client.query(`SET SESSION AUTHORIZATION ${identifier(role)}`);
    try {
      return await operation();
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
    }
  }

  async function expect42501(sql: string, params: unknown[] = []): Promise<void> {
    await client.query('SAVEPOINT expected_denial');
    try {
      await expect(client.query(sql, params)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT expected_denial');
      await client.query('RELEASE SAVEPOINT expected_denial');
    }
  }

  async function count(table: string): Promise<number> {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM genie_spike.${table}`);
    return Number(result.rows[0]?.count ?? 0);
  }

  it('rejects direct non-member reads, including the internal guard, with 42501 and returns no data', async () => {
    await asPrincipal(roles.outsider, async () => {
      await expect42501(`SELECT genie_spike.assert_chase_access('task-a',false)`);
      await expect42501(`SELECT * FROM genie_spike.get_task_schedule_config('task-a')`);
      await expect42501(`SELECT * FROM genie_spike.get_chase_preview('task-a')`);
    });

    expect(await count('task_schedule_config')).toBe(0);
    expect(await count('chase_item_status')).toBe(0);
  });

  it('rejects every direct non-owner/non-admin write with 42501 and changes no rows', async () => {
    await asPrincipal(roles.member, async () => {
      await expect42501(`SELECT genie_spike.assert_chase_access('task-a',true)`);
      await expect42501(
        `SELECT * FROM genie_spike.save_task_schedule_config(
          $1,true,'daily',2,NULL,ARRAY[7,2],ARRAY[1,7,14],TIME '18:00',TIME '08:00','Europe/Berlin')`,
        ['task-a']
      );
      await expect42501(`SELECT genie_spike.save_chase_item_status($1,$2,now(),'overdue',NULL,10.00)`, [
        'task-a',
        'REM-DENIED',
      ]);
      await expect42501(`SELECT genie_spike.resolve_missing_chase_items($1,ARRAY[]::text[])`, ['task-a']);
    });

    expect(await count('task_schedule_config')).toBe(0);
    expect(await count('chase_item_status')).toBe(0);
    expect(await count('task_activity')).toBe(0);
  });

  it('allows owner/admin writes and member reads through the real functions', async () => {
    await asPrincipal(roles.owner, async () => {
      const saved: QueryResult = await client.query(
        `SELECT * FROM genie_spike.save_task_schedule_config(
          $1,true,'daily',2,NULL,ARRAY[7,2],ARRAY[1,7,14],TIME '18:00',TIME '08:00','Europe/Berlin')`,
        ['task-a']
      );
      expect(saved.rowCount).toBe(1);
      await client.query(`SELECT genie_spike.save_chase_item_status($1,$2,now(),'overdue',NULL,10.00)`, [
        'task-a',
        'REM-ALLOWED',
      ]);
    });

    await asPrincipal(roles.member, async () => {
      const config = await client.query(`SELECT * FROM genie_spike.get_task_schedule_config('task-a')`);
      const preview = await client.query(`SELECT * FROM genie_spike.get_chase_preview('task-a')`);
      expect(config.rowCount).toBe(1);
      expect(preview.rows.map((row: Record<string, unknown>) => row['item_reference'])).toEqual(['REM-ALLOWED']);
    });

    await asPrincipal(roles.admin, async () => {
      await client.query(`SELECT genie_spike.resolve_missing_chase_items($1,ARRAY[]::text[])`, ['task-a']);
    });
    expect(await count('task_schedule_config')).toBe(1);
    expect(await count('chase_item_status')).toBe(1);
    const resolved = await client.query<{ state: string }>(
      `SELECT state FROM genie_spike.chase_item_status WHERE task_id='task-a'`
    );
    expect(resolved.rows[0]?.state).toBe('resolved');
  });

  it('evaluates the taskless shared ledger and rejects a second enabled schedule owner', async () => {
    const remittanceColumns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='genie_spike' AND table_name='remittance'
        ORDER BY ordinal_position`
    );
    expect(remittanceColumns.rows.map((row) => row.column_name)).toEqual([
      'remittance_id',
      'subsidiary_id',
      'period',
      'total_amount',
      'entity_version',
    ]);

    await asPrincipal(roles.scheduler, async () => {
      const items = await client.query(
        `SELECT item_reference,outstanding_amount
           FROM genie_spike.get_chase_scheduler_items('task-a')`
      );
      expect(items.rows).toEqual([
        { item_reference: 'REM-SHARED-1', outstanding_amount: '75.00' },
        { item_reference: 'REM-SHARED-2', outstanding_amount: '50.00' },
      ]);
    });

    await asPrincipal(roles.outsider, async () => {
      await expect42501(
        `SELECT * FROM genie_spike.save_task_schedule_config(
          $1,true,'daily',2,NULL,ARRAY[7,2],ARRAY[1,7,14],TIME '18:00',TIME '08:00','Europe/Berlin')`,
        ['task-b']
      );
    });
    const secondConfig = await client.query(
      `SELECT 1 FROM genie_spike.task_schedule_config WHERE task_id='task-b'`
    );
    expect(secondConfig.rowCount).toBe(0);
  });

  it('denies member and outsider batch approval without changing outbox state, then allows the owner', async () => {
    const batchId = '11111111-1111-4111-8111-111111111111';
    const deliveryId = '22222222-2222-4222-8222-222222222222';
    await client.query(
      `INSERT INTO genie_spike.chase_batch(batch_id,task_id,evaluated_at)
       VALUES($1,'task-a',now())`,
      [batchId]
    );
    await client.query(
      `INSERT INTO genie_spike.chase_delivery(
         delivery_id,batch_id,task_id,item_reference,due_at,offset_kind,offset_days,checkpoint_at)
       VALUES($1,$2,'task-a','REM-APPROVAL',now() + interval '2 days','approach',2,now())`,
      [deliveryId, batchId]
    );

    for (const deniedRole of [roles.member, roles.outsider]) {
      await asPrincipal(deniedRole, async () => {
        await expect42501(`SELECT * FROM genie_spike.approve_chase_batch($1::uuid,'denied')`, [batchId]);
      });
      const deniedState = await client.query<{ batch_status: string; delivery_status: string }>(
        `SELECT b.status AS batch_status,d.status AS delivery_status
           FROM genie_spike.chase_batch b JOIN genie_spike.chase_delivery d USING(batch_id)
          WHERE b.batch_id=$1`,
        [batchId]
      );
      expect(deniedState.rows[0]).toEqual({ batch_status: 'pending', delivery_status: 'pending' });
    }

    await asPrincipal(roles.owner, async () => {
      const approved = await client.query(
        `SELECT * FROM genie_spike.approve_chase_batch($1::uuid,'owner approved')`,
        [batchId]
      );
      expect(approved.rows[0]).toMatchObject({
        old_status: 'pending',
        new_status: 'approved',
        item_count: '1',
        actor: roles.owner,
      });
    });
    const approvedState = await client.query<{ batch_status: string; delivery_status: string }>(
      `SELECT b.status AS batch_status,d.status AS delivery_status
         FROM genie_spike.chase_batch b JOIN genie_spike.chase_delivery d USING(batch_id)
        WHERE b.batch_id=$1`,
      [batchId]
    );
    expect(approvedState.rows[0]).toEqual({ batch_status: 'approved', delivery_status: 'eligible' });
  });
});

if (!databaseUrl) {
  describe('chase Postgres integration availability', () => {
    it('skips database authorization execution when CHASE_TEST_DATABASE_URL is not configured', () => {
      expect(databaseUrl).toBeUndefined();
    });
  });
}
