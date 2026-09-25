import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/004_chase_scheduler.sql', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../databricks.yml', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('../chase_scheduler/scheduler.py', import.meta.url), 'utf8');

describe('scheduled chase evaluation', () => {
  it('keeps transport no-op and every outbox row pending', () => {
    expect(migration).toContain("status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending'))");
    expect(migration).toContain("transport_adapter TEXT NOT NULL DEFAULT 'noop' CHECK (transport_adapter = 'noop')");
    expect(scheduler).toContain('class NoOpTransport');
    expect(scheduler.match(/selected_transport\.deliver\(/g)).toHaveLength(1);
    const noOpBody = scheduler.match(/class NoOpTransport:[^]*?(?=\n\ndef )/)?.[0] ?? '';
    expect(noOpBody.match(/genie_spike\.[a-z_]+/g)).toEqual(['genie_spike.mark_chase_noop']);
    expect(scheduler).not.toMatch(/\b(?:email|sendgrid|smtp|smtplib|sql[_. -]?alert|webhook|requests|urllib|httpx?)\b/i);
  });

  it('deduplicates once per offset crossing and updates last_notified only after insert', () => {
    expect(migration).toContain('UNIQUE(task_id,item_reference,due_at,offset_kind,offset_days)');
    expect(migration).toContain('ON CONFLICT(task_id,item_reference,due_at,offset_kind,offset_days) DO NOTHING');
    expect(migration).toContain('SET last_notified_at=p_evaluated_at');
  });

  it('uses only security-definer functions for the dedicated scheduler identity', () => {
    expect(migration).toContain('REVOKE ALL ON genie_spike.chase_batch,genie_spike.chase_delivery FROM :"scheduler_role"');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION genie_spike.get_chase_scheduler_tasks()');
    expect(migration).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE).*TO :"scheduler_role"/);
  });

  it('deploys the verified scheduler and projection schedules unpaused', () => {
    expect(bundle).toContain('quartz_cron_expression: ${var.chase_scheduler_cron}');
    expect(bundle).toContain('service_principal_name: ${var.chase_scheduler_sp}');
    const projection = bundle.split('publish_receivables_projection:', 2)[1]?.split('chase_scheduler:', 1)[0] ?? '';
    const chase = bundle.split('chase_scheduler:', 2)[1]?.split('targets:', 1)[0] ?? '';
    expect(projection).toContain("quartz_cron_expression: '0 0/5 * * * ?'");
    expect(projection).toContain('pause_status: UNPAUSED');
    expect(chase).toContain('pause_status: UNPAUSED');
  });
});
