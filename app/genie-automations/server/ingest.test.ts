import { describe, expect, it } from 'vitest';
import { ingestGateFailure, safeExtension, sha256, uploadPath } from './ingest';

describe('ingest upload identity', () => {
  it('hashes bytes and creates a server-owned relative path', () => {
    const digest = sha256(Buffer.from('remittance_id,amount\nR1,10.00\n'));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(uploadPath('receivables-eu', digest, 'csv')).toBe(`receivables-eu/${digest}/original.csv`);
    expect(uploadPath('receivables-eu', digest, 'csv')).not.toContain('/Volumes/');
  });

  it('allows only deterministic spreadsheet formats', () => {
    expect(safeExtension('report.CSV')).toBe('csv');
    expect(safeExtension('../../payload.js')).toBeNull();
    expect(safeExtension('macro.xlsm')).toBeNull();
  });
});

describe('ingest task gate', () => {
  const complete = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
  it('requires membership', () => expect(ingestGateFailure({ ...complete, is_member: false })).toBe('not_member'));
  it('requires ingest to be enabled', () => expect(ingestGateFailure({ ...complete, ingest_enabled: false })).toBe('ingest_disabled'));
  it('requires the complete three-part target', () => expect(ingestGateFailure({ ...complete, target_catalog: null })).toBe('target_unbound'));
  it('accepts a fully bound member task', () => expect(ingestGateFailure(complete)).toBeNull());
});
