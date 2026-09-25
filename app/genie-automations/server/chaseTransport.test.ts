import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/005_chase_transport.sql', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../databricks.yml', import.meta.url), 'utf8');
const publisher = readFileSync(new URL('../projection/publish_chase.py', import.meta.url), 'utf8');
const projectionView = readFileSync(new URL('../projection/sql/create_chase_projection.sql', import.meta.url), 'utf8');

function functionBody(name: string): string {
  return migration.match(new RegExp(`FUNCTION genie_spike\\.${name}[^]*?AS \\$\\$([^]*?)\\$\\$;`))?.[1] ?? '';
}

describe('approved chase transport', () => {
  it('authorizes inside both definer mutation functions before writing', () => {
    for (const name of ['approve_chase_batch', 'archive_chase_batch']) {
      const body = functionBody(name);
      const authorization = body.indexOf("has_table_privilege(session_user,'genie_spike.destination_allowlist','DELETE')");
      const rejection = body.indexOf("ERRCODE='42501'");
      const write = body.indexOf('UPDATE genie_spike.chase_batch');
      expect(authorization, name).toBeGreaterThanOrEqual(0);
      expect(rejection, name).toBeGreaterThan(authorization);
      expect(write, name).toBeGreaterThan(rejection);
    }
  });

  it('preserves dedupe and gives the publisher function-only access', () => {
    expect(migration).not.toMatch(/DROP\s+(?:CONSTRAINT|INDEX)[^;]*(?:task_id|item_reference|offset_days)/i);
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION genie_spike.get_approved_chase_reminders(TEXT) TO :"publisher_role"');
    expect(migration).toContain('REVOKE ALL ON genie_spike.chase_batch,genie_spike.chase_delivery');
    expect(migration).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*TO :"publisher_role"/);
    expect(migration).toContain('GRANT USAGE ON SCHEMA genie_spike TO :"publisher_role"');
  });

  it('exposes exactly the eight approved reminder contract columns', () => {
    const selected = projectionView
      .split('\nSELECT\n', 2)[1]
      ?.split('\nFROM ', 1)[0]
      ?.split(',')
      .map((column) => column.trim());
    expect(selected).toEqual([
      'task_id',
      'task_name',
      'owner_email',
      'item_reference',
      'due_at',
      'offset_kind',
      'offset_days',
      'approved_at',
    ]);
    const alertQuery = bundle.split('approved_chase_digest:', 2)[1]?.split('evaluation:', 1)[0] ?? '';
    expect(alertQuery).not.toContain('announcement_window');
    expect(alertQuery).not.toContain('projection_as_of');
  });

  it('derives recipient identity from the task owner and validated owner membership', () => {
    const body = functionBody('get_approved_chase_reminders');
    expect(body).toContain('t.owner_id');
    expect(body).toContain("owner_member.role='owner'");
    expect(body).toContain('lower(owner_member.user_id)=lower(t.owner_id)');
  });

  it('deploys all verified scheduled resources unpaused', () => {
    const receivables = bundle.split('publish_receivables_projection:', 2)[1]?.split('chase_scheduler:', 1)[0] ?? '';
    const scheduler = bundle.split('chase_scheduler:', 2)[1]?.split('publish_approved_chase_reminders:', 1)[0] ?? '';
    const projection = bundle.split('publish_approved_chase_reminders:', 2)[1]?.split('alerts:', 1)[0] ?? '';
    const alert = bundle.split('approved_chase_digest:', 2)[1]?.split('targets:', 1)[0] ?? '';
    expect(receivables).toContain('pause_status: UNPAUSED');
    expect(scheduler).toContain('pause_status: UNPAUSED');
    expect(projection).toContain('pause_status: UNPAUSED');
    expect(alert).toContain('pause_status: UNPAUSED');
    expect(alert).toContain('{{QUERY_RESULT_TABLE}}');
    expect(alert).toContain('overflow_count');
  });

  it('marks rows announced rather than sent and does not add an external transport', () => {
    expect(migration).toContain("SET status='announced'");
    expect(migration).not.toMatch(/status='sent'/i);
    expect(publisher).not.toMatch(/smtp|sendgrid|requests\.|httpx|webhook/i);
  });
});
