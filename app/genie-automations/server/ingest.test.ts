import { describe, expect, it } from 'vitest';
import {
  ingestGateFailure,
  detectIngestType,
  extensionMatchesDetectedType,
  isAlreadyExists,
  parseRunStatus,
  safeExtension,
  sha256,
  uploadPath,
  validCsvBytes,
} from './ingest';

describe('ingest upload identity', () => {
  it('hashes bytes and creates a server-owned relative path', () => {
    const digest = sha256(Buffer.from('remittance_id,amount\nR1,10.00\n'));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(uploadPath('receivables-eu', digest, 'csv')).toBe(`receivables-eu/${digest}/original.csv`);
    expect(uploadPath('receivables-eu', digest, 'csv')).not.toContain('/Volumes/');
  });

  it('accepts supported extensions while classifying images separately', () => {
    expect(safeExtension('report.CSV')).toBe('csv');
    expect(safeExtension('../../payload.js')).toBeNull();
    expect(safeExtension('macro.xlsm')).toBeNull();
    expect(safeExtension('capture.PNG')).toBe('png');
  });

  it('detects modality from bytes and rejects filename conflicts', () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]);
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    expect(detectIngestType(png)).toBe('png');
    expect(detectIngestType(jpeg)).toBe('jpeg');
    expect(extensionMatchesDetectedType('png', 'png')).toBe(true);
    expect(extensionMatchesDetectedType('jpg', 'jpeg')).toBe(true);
    expect(extensionMatchesDetectedType('jpg', 'png')).toBe(false);
    expect(detectIngestType(Buffer.from('not an image'))).toBeNull();
  });

  it('rejects binary CSV content while allowing UTF-8 and cp1252 text', () => {
    expect(validCsvBytes(Buffer.from('name,amount\nCafé,10\n', 'utf8'))).toBe(true);
    expect(validCsvBytes(Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x2c, 0x61, 0x6d, 0x6f, 0x75, 0x6e, 0x74, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x30]))).toBe(true);
    expect(validCsvBytes(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(false);
    expect(validCsvBytes(Buffer.alloc(512, 0x89))).toBe(false);
    expect(validCsvBytes(Buffer.from('not a delimited file\nstill not delimited'))).toBe(false);
    expect(validCsvBytes(Buffer.from('a,b\n1\n'))).toBe(false);
  });

  it('recognizes immutable-upload conflicts only', () => {
    expect(isAlreadyExists(Object.assign(new Error('already exists'), { status: 409 }))).toBe(true);
    expect(isAlreadyExists(new Error('permission denied'))).toBe(false);
  });
});

describe('parse Job status', () => {
  it.each([
    [{ state: { life_cycle_state: 'PENDING' } }, 'pending'],
    [{ state: { life_cycle_state: 'RUNNING' } }, 'running'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } }, 'succeeded'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' } }, 'failed'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'CANCELED' } }, 'failed'],
    [{ state: { life_cycle_state: 'SKIPPED' } }, 'failed'],
  ])('normalizes lifecycle and result state', (run, expected) => expect(parseRunStatus(run)).toBe(expected));
});

describe('ingest task gate', () => {
  const complete = { is_member: true, ingest_enabled: true, target_catalog: 'c', target_schema: 's', target_table: 't' };
  it('requires membership', () => expect(ingestGateFailure({ ...complete, is_member: false })).toBe('not_member'));
  it('requires ingest to be enabled', () => expect(ingestGateFailure({ ...complete, ingest_enabled: false })).toBe('ingest_disabled'));
  it('requires the complete three-part target', () => expect(ingestGateFailure({ ...complete, target_catalog: null })).toBe('target_unbound'));
  it('accepts a fully bound member task', () => expect(ingestGateFailure(complete)).toBeNull());
});
