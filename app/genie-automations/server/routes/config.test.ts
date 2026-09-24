import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    expect(appYaml).not.toContain('CONFIG_ADMIN_PRINCIPALS');
    expect(bundle).toMatch(/config_admin_principals:\n\s+description:[^\n]+\n\s+config_destination_allowlist:/);
    expect(bundle).toMatch(/config_destination_allowlist:\n\s+description:[^\n]+\n\nresources:/);
    expect(bundle).not.toContain('felix.mutzl@databricks.com');
  });
});
