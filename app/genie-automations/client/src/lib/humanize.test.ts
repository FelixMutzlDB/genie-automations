import { describe, expect, it } from 'vitest';
import { humanizeActor, summarizeChange } from './humanize';

describe('summarizeChange', () => {
  it('summarizes an allocation update', () => {
    expect(summarizeChange('allocation', { allocation_id: 'A-2', remittance_id: 'RDEMO-1', amount: 1150 })).toBe(
      'Set allocation A-2 on RDEMO-1 to €1,150.00.'
    );
  });

  it('summarizes a vendor bank update without exposing the full IBAN', () => {
    expect(
      summarizeChange('vendor_bank', {
        vendor_id: 'VEND-1003',
        iban: 'NL91ABNA0417164300',
        bic: 'ABNANL2A',
        effective_date: '2027-05-01',
      })
    ).toBe('Update VEND-1003 bank details — IBAN ending 4300, effective 1 May 2027.');
  });

  it('does not throw when fields are missing', () => {
    expect(() => summarizeChange('vendor_bank', undefined)).not.toThrow();
    expect(summarizeChange('vendor_bank', {})).toBe('Proposed change to the vendor bank details.');
  });
});

describe('humanizeActor', () => {
  it('turns an email local-part into a friendly name', () => {
    expect(humanizeActor('ops.alice@company.example')).toBe('Ops Alice');
  });

  it('handles missing identities', () => {
    expect(humanizeActor(null)).toBe('Someone');
  });
});
